import { parseAbiItem } from "viem";
import type { Logger } from "../../logger.js";
import type { HttpClient, WsClient } from "../../chain/client.js";
import { ExponentialBackoff, type BackoffOptions } from "../../chain/backoff.js";
import { chunkBlockRange } from "../../chain/newTokenDetector.js";
import type { DopplerCreateArgs, PonsTokenLaunchedArgs } from "../../chain/newTokenDetector.js";
import { DOPPLER_CREATE_EVENT, PONS_TOKEN_LAUNCHED_EVENT } from "../../chain/newTokenDetector.js";
import {
  DOPPLER_MODIFY_LIQUIDITY_EVENT,
  DOPPLER_SWAP_EVENT,
  PONS_V3_SWAP_EVENT,
  computeDopplerPoolId,
  createTradeDetectorHttpClient,
  type DopplerModifyLiquidityArgs,
  type DopplerSwapArgs,
  type PonsSwapArgs,
} from "../../chain/tradeDetector.js";
import { resolveTokenDecimals, resolveTokenMetadata } from "../../chain/erc20.js";
import { classifyDopplerSwap, classifyPonsSwap, currencyPairKey } from "./tradeClassification.js";
import type {
  ChainAdapter,
  ChainSourceDescriptor,
  LaunchEvent,
  LiquiditySnapshot,
  SellabilityResult,
  TokenMetadata,
  TokenTransferEvent,
  TradeEvent,
} from "../types.js";

// The real ChainAdapter implementation for Robinhood Chain (spec Phase A/B —
// the only chain actually implemented; solana/bsc/bch are scaffolds only).
//
// Core B1 change from V1: launch/trade/holder discovery here uses real WSS
// event-level subscriptions (viem's `watchEvent` over a WebSocket
// transport, which uses `eth_subscribe("logs", filter)` — confirmed
// live against this chain's RPC, see PROGRESS.md Phase A/B RPC test)
// instead of V1's per-live-block `eth_getLogs` polling
// (chain/watcher.ts + chain/tradeDetector.ts / newTokenDetector.ts). That
// polling model is untouched — V1 keeps using it — this is a parallel,
// independent implementation.

const ERC20_TRANSFER_EVENT = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

const ERC20_TOTAL_SUPPLY_ABI = [
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

/** Zero-address sentinel this chain uses for "native ETH" as a pair token
 * (same convention V1's quoteSymbolCache in index.ts relies on). */
const NATIVE_SENTINEL = /^0x0+$/;

interface TokenRouting {
  address: string;
  source: "doppler" | "pons_v1";
  pairToken: string;
  pool: string;
  initializer: string | null;
  creator: string | null;
}

export interface RobinhoodAdapterDeps {
  httpClient: HttpClient;
  createWsClient: () => WsClient;
  dopplerAirlockAddress: `0x${string}`;
  ponsV1FactoryAddress: `0x${string}`;
  logger: Logger;
  /** How often the trade/holder feeds re-check getHotAddresses() and
   * refresh their subscriptions (spec A.3: 10-15s). Default 12s. */
  resubscribeIntervalMs?: number;
  backoffOptions?: Partial<BackoffOptions>;
  maxLogsBlockRange?: bigint;
}

/** A single reconnect-on-error WSS subscription slot, shared shape for
 * launch/trade/holder feeds — each owns one live viem `watchEvent` unwatch
 * function plus its own backoff state, so one feed's disconnect never
 * affects another's. */
function createReconnectingWatch(deps: {
  logger: Logger;
  backoffOptions?: Partial<BackoffOptions>;
  connect: () => (() => void) | null;
  /** B3 §5 observability — fired each time this watch has to reconnect
   * after an error, so a caller (the adapter's getStatus()) can surface a
   * WSS reconnect count without every consumer re-deriving it from logs. */
  onReconnect?: () => void;
}) {
  const backoff = new ExponentialBackoff(deps.backoffOptions);
  let unwatch: (() => void) | null = null;
  let stopped = false;
  let connected = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleReconnect(): void {
    if (stopped) return;
    const delayMs = backoff.next();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      start();
    }, delayMs);
  }

  function start(): void {
    if (stopped) return;
    try {
      unwatch = deps.connect();
      connected = true;
      backoff.reset();
    } catch (err) {
      connected = false;
      deps.logger.warn({ err }, "WSS subscription failed to start, will retry");
      scheduleReconnect();
    }
  }

  return {
    start,
    onError(err: Error): void {
      deps.logger.warn({ err }, "WSS subscription error — reconnecting");
      connected = false;
      deps.onReconnect?.();
      if (unwatch) {
        unwatch();
        unwatch = null;
      }
      scheduleReconnect();
    },
    stop(): void {
      stopped = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (unwatch) unwatch();
      unwatch = null;
    },
    isConnected(): boolean {
      return connected;
    },
  };
}

export interface RobinhoodAdapterStatus {
  connected: boolean;
  lastKnownBlock: bigint | null;
  reconnectCount: number;
}

export interface RobinhoodAdapter extends ChainAdapter {
  getStatus(): RobinhoodAdapterStatus;
}

export function createRobinhoodAdapter(deps: RobinhoodAdapterDeps): RobinhoodAdapter {
  const resubscribeIntervalMs = deps.resubscribeIntervalMs ?? 12_000;
  const chunkSize = deps.maxLogsBlockRange ?? 10_000n;
  const tradeHttpClient = createTradeDetectorHttpClient(deps.httpClient);

  // Populated as launches are observed (or backfilled) — the routing
  // table every other method needs to turn a bare token address back into
  // "which launchpad, which pool/initializer contract, which pair token".
  const routing = new Map<string, TokenRouting>();
  // Doppler-only: poolId resolution mirrors chain/tradeDetector.ts exactly
  // (see that file's resolvePoolIdFromModifyLiquidity comment) — a token's
  // real PoolId is only learned from its first ModifyLiquidity log.
  const dopplerPairKeyToToken = new Map<string, string>();
  const dopplerPoolIdToToken = new Map<string, string>();
  const dopplerResolvedTokens = new Set<string>();
  // Pons-only: pool contract address -> token address (Pons pools are
  // standard Uniswap V3, no poolId indirection needed like Doppler).
  const poolToToken = new Map<string, string>();

  let launchWatch: ReturnType<typeof createReconnectingWatch> | null = null;
  let tradeWatch: { doppler: (() => void) | null; pons: (() => void) | null; modifyLiquidity: (() => void) | null } = {
    doppler: null,
    pons: null,
    modifyLiquidity: null,
  };
  let holderWatch: (() => void) | null = null;
  let tradeResubscribeTimer: ReturnType<typeof setInterval> | null = null;
  let holderResubscribeTimer: ReturnType<typeof setInterval> | null = null;
  let lastTradeAddressKey = "";
  let lastHolderAddressKey = "";

  // B1.8 recovery: track the highest block number any live log has
  // carried, so a WS reconnect can backfill exactly the gap it missed via
  // a small-range getLogs call before resuming the subscription — never an
  // unbounded or per-block backfill.
  let lastKnownBlock: bigint | null = null;
  function trackBlock(blockNumber: bigint): void {
    if (lastKnownBlock === null || blockNumber > lastKnownBlock) lastKnownBlock = blockNumber;
  }

  // B3 §5 observability only — tracked off the launch subscription (the one
  // always-on feed regardless of hot-candidate count); trade/holder feeds
  // share the same underlying RPC endpoint so a real network-level outage
  // shows up here too, even though this isn't a literal union of all three
  // feeds' individual connection states.
  let reconnectCount = 0;
  async function recoverGap(params: {
    label: string;
    address: `0x${string}` | `0x${string}`[];
    event: Parameters<WsClient["watchEvent"]>[0]["event"];
    onLogs: (logs: unknown[]) => void;
  }): Promise<void> {
    if (lastKnownBlock === null) return;
    try {
      const current = await deps.httpClient.getBlockNumber();
      if (current <= lastKnownBlock) return;
      const fromBlock = lastKnownBlock + 1n;
      deps.logger.info(
        { label: params.label, fromBlock: fromBlock.toString(), toBlock: current.toString() },
        "robinhood adapter: WS reconnect — backfilling gap via getLogs",
      );
      for (const chunk of chunkBlockRange(fromBlock, current, chunkSize)) {
        const logs = await deps.httpClient.getLogs({
          address: params.address,
          event: params.event,
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
        });
        if (logs.length > 0) params.onLogs(logs);
      }
    } catch (err) {
      deps.logger.warn({ err, label: params.label }, "robinhood adapter: gap backfill failed — continuing with live subscription only");
    }
  }

  function registerRouting(entry: TokenRouting): void {
    routing.set(entry.address.toLowerCase(), entry);
    if (entry.source === "pons_v1") {
      poolToToken.set(entry.pool.toLowerCase(), entry.address.toLowerCase());
    }
  }

  async function handleDopplerCreateLog(log: {
    args: DopplerCreateArgs;
    transactionHash: `0x${string}`;
    blockNumber: bigint;
  }, onLaunch: (event: LaunchEvent) => void): Promise<void> {
    try {
      trackBlock(log.blockNumber);
      const [tx, block] = await Promise.all([
        deps.httpClient.getTransaction({ hash: log.transactionHash }),
        deps.httpClient.getBlock({ blockNumber: log.blockNumber }),
      ]);
      registerRouting({
        address: log.args.asset,
        source: "doppler",
        pairToken: log.args.numeraire,
        pool: log.args.poolOrHook,
        initializer: log.args.initializer,
        creator: tx.from,
      });
      onLaunch({
        chain: "robinhood",
        source: "doppler",
        tokenAddress: log.args.asset,
        creator: tx.from,
        pairToken: log.args.numeraire,
        pool: log.args.poolOrHook,
        launchedAt: new Date(Number(block.timestamp) * 1000),
        launchBlockNumber: log.blockNumber,
        launchBlockHash: block.hash,
        launchTxHash: log.transactionHash,
      });
    } catch (err) {
      deps.logger.error({ err, tx: log.transactionHash }, "robinhood adapter: failed to process Doppler Create log");
    }
  }

  async function handlePonsLaunchedLog(log: {
    args: PonsTokenLaunchedArgs;
    transactionHash: `0x${string}`;
    blockNumber: bigint;
  }, onLaunch: (event: LaunchEvent) => void): Promise<void> {
    try {
      trackBlock(log.blockNumber);
      const block = await deps.httpClient.getBlock({ blockNumber: log.blockNumber });
      registerRouting({
        address: log.args.token,
        source: "pons_v1",
        pairToken: log.args.pairToken,
        pool: log.args.pool,
        initializer: null,
        creator: log.args.deployer,
      });
      onLaunch({
        chain: "robinhood",
        source: "pons_v1",
        tokenAddress: log.args.token,
        creator: log.args.deployer,
        pairToken: log.args.pairToken,
        pool: log.args.pool,
        launchedAt: new Date(Number(block.timestamp) * 1000),
        launchBlockNumber: log.blockNumber,
        launchBlockHash: block.hash,
        launchTxHash: log.transactionHash,
      });
    } catch (err) {
      deps.logger.error({ err, tx: log.transactionHash }, "robinhood adapter: failed to process Pons TokenLaunched log");
    }
  }

  async function emitTrade(params: {
    token: TokenRouting;
    side: TradeEvent["side"];
    tokenAmount: bigint;
    quoteAmount: bigint;
    blockNumber: bigint;
    transactionHash: `0x${string}`;
    logIndex: number;
    onTrade: (trade: TradeEvent) => void;
  }): Promise<void> {
    try {
      trackBlock(params.blockNumber);
      const [walletResolution, block] = await Promise.all([
        tradeHttpClient.resolveTradeWallet({ transactionHash: params.transactionHash, logIndex: params.logIndex }),
        deps.httpClient.getBlock({ blockNumber: params.blockNumber }),
      ]);
      params.onTrade({
        chain: "robinhood",
        tokenAddress: params.token.address,
        wallet: walletResolution.wallet.toLowerCase(),
        side: params.side,
        tokenAmount: params.tokenAmount < 0n ? -params.tokenAmount : params.tokenAmount,
        quoteAmount: params.quoteAmount < 0n ? -params.quoteAmount : params.quoteAmount,
        usdValue: null,
        blockNumber: params.blockNumber,
        txHash: params.transactionHash,
        logIndex: params.logIndex,
        timestamp: new Date(Number(block.timestamp) * 1000),
      });
    } catch (err) {
      deps.logger.error({ err, tx: params.transactionHash }, "robinhood adapter: failed to resolve trade");
    }
  }

  function hotDopplerInitializers(hotTokens: TokenRouting[]): `0x${string}`[] {
    return Array.from(
      new Set(
        hotTokens
          .filter((t): t is TokenRouting & { initializer: string } => t.source === "doppler" && t.initializer !== null)
          .map((t) => t.initializer.toLowerCase()),
      ),
    ) as `0x${string}`[];
  }

  function hotPonsPools(hotTokens: TokenRouting[]): `0x${string}`[] {
    return Array.from(new Set(hotTokens.filter((t) => t.source === "pons_v1").map((t) => t.pool.toLowerCase()))) as `0x${string}`[];
  }

  return {
    chainKey: "robinhood",

    async startLaunchDiscovery(onLaunch) {
      launchWatch = createReconnectingWatch({
        logger: deps.logger,
        backoffOptions: deps.backoffOptions,
        onReconnect: () => {
          reconnectCount++;
        },
        connect: () => {
          const ws = deps.createWsClient();
          const onDopplerCreateLogs = (logs: unknown[]): void => {
            for (const log of logs as { args: unknown; transactionHash: `0x${string}`; blockNumber: bigint }[]) {
              void handleDopplerCreateLog(
                { args: log.args as DopplerCreateArgs, transactionHash: log.transactionHash, blockNumber: log.blockNumber },
                onLaunch,
              );
            }
          };
          const onPonsLaunchedLogs = (logs: unknown[]): void => {
            for (const log of logs as { args: unknown; transactionHash: `0x${string}`; blockNumber: bigint }[]) {
              void handlePonsLaunchedLog(
                { args: log.args as PonsTokenLaunchedArgs, transactionHash: log.transactionHash, blockNumber: log.blockNumber },
                onLaunch,
              );
            }
          };
          // viem can't statically prove every named param decodes for a
          // non-`strict` watch, even though it always does for a matched
          // log — same cast chain/newTokenDetector.ts's getLogs wrapper
          // uses for the identical reason.
          const unwatchCreate = ws.watchEvent({
            address: deps.dopplerAirlockAddress,
            event: DOPPLER_CREATE_EVENT,
            onLogs: onDopplerCreateLogs,
            onError: (err) => launchWatch?.onError(err),
          });
          const unwatchLaunched = ws.watchEvent({
            address: deps.ponsV1FactoryAddress,
            event: PONS_TOKEN_LAUNCHED_EVENT,
            onLogs: onPonsLaunchedLogs,
            onError: (err) => launchWatch?.onError(err),
          });
          // B1.8: recover any launches that happened during a disconnect
          // window before the reconnected subscription starts covering
          // things live — bounded getLogs from lastKnownBlock, not from genesis.
          void recoverGap({ label: "doppler-create", address: deps.dopplerAirlockAddress, event: DOPPLER_CREATE_EVENT, onLogs: onDopplerCreateLogs });
          void recoverGap({ label: "pons-launched", address: deps.ponsV1FactoryAddress, event: PONS_TOKEN_LAUNCHED_EVENT, onLogs: onPonsLaunchedLogs });
          return () => {
            unwatchCreate();
            unwatchLaunched();
          };
        },
      });
      launchWatch.start();
    },

    async stopLaunchDiscovery() {
      launchWatch?.stop();
      launchWatch = null;
    },

    async startHotTradeFeed(getHotAddresses, onTrade) {
      function refresh(): void {
        const hotTokens = getHotAddresses()
          .map((addr) => routing.get(addr.toLowerCase()))
          .filter((t): t is TokenRouting => t !== undefined);
        const initializers = hotDopplerInitializers(hotTokens);
        const pools = hotPonsPools(hotTokens);
        const key = `${initializers.join(",")}|${pools.join(",")}`;
        if (key === lastTradeAddressKey) return;
        lastTradeAddressKey = key;

        tradeWatch.doppler?.();
        tradeWatch.modifyLiquidity?.();
        tradeWatch.pons?.();
        tradeWatch = { doppler: null, pons: null, modifyLiquidity: null };

        // Rebuild pending-poolId lookups for Doppler tokens on this hot set
        // that haven't resolved a real PoolId from ModifyLiquidity yet.
        for (const token of hotTokens) {
          if (token.source !== "doppler" || token.initializer === null) continue;
          if (dopplerResolvedTokens.has(token.address.toLowerCase())) continue;
          dopplerPairKeyToToken.set(currencyPairKey(token.address, token.pairToken), token.address);
        }

        function onDopplerSwapLogs(logs: unknown[]): void {
          for (const log of logs as { args: unknown; blockNumber: bigint; transactionHash: `0x${string}`; logIndex: number | null }[]) {
            trackBlock(log.blockNumber);
            const args = log.args as DopplerSwapArgs;
            const token = dopplerPoolIdToToken.get(args.poolId.toLowerCase());
            if (!token) continue;
            const routed = routing.get(token);
            if (!routed) continue;
            const classified = classifyDopplerSwap(args, routed.address, routed.pairToken);
            void emitTrade({
              token: routed,
              side: classified.side,
              tokenAmount: classified.tokenAmount,
              quoteAmount: classified.quoteAmount,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              logIndex: log.logIndex ?? 0,
              onTrade,
            });
          }
        }

        function onPonsSwapLogs(logs: unknown[]): void {
          for (const log of logs as { args: unknown; address: `0x${string}`; blockNumber: bigint; transactionHash: `0x${string}`; logIndex: number | null }[]) {
            trackBlock(log.blockNumber);
            // log.address here is the POOL contract (we subscribed at
            // `pools`), not the token — routing is keyed by token
            // address, so reverse-look-up via poolToToken.
            const tokenAddress = poolToToken.get(log.address.toLowerCase());
            const token = tokenAddress ? routing.get(tokenAddress) : undefined;
            if (!token) continue;
            const args = log.args as PonsSwapArgs;
            const classified = classifyPonsSwap(args, token.address, token.pairToken);
            void emitTrade({
              token,
              side: classified.side,
              tokenAmount: classified.tokenAmount,
              quoteAmount: classified.quoteAmount,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              logIndex: log.logIndex ?? 0,
              onTrade,
            });
          }
        }

        if (initializers.length > 0) {
          const ws = deps.createWsClient();
          tradeWatch.doppler = ws.watchEvent({
            address: initializers,
            event: DOPPLER_SWAP_EVENT,
            onLogs: onDopplerSwapLogs,
            // B1.8: force the next timer tick to resubscribe even though
            // the address set itself hasn't changed — refresh()'s diff
            // check only fires on an actual set change otherwise.
            onError: (err) => {
              deps.logger.warn({ err }, "robinhood adapter: Doppler swap watch error — will resubscribe");
              lastTradeAddressKey = "";
            },
          });
          void recoverGap({ label: "doppler-swap", address: initializers, event: DOPPLER_SWAP_EVENT, onLogs: onDopplerSwapLogs });

          const wsModify = deps.createWsClient();
          tradeWatch.modifyLiquidity = wsModify.watchEvent({
            address: initializers,
            event: DOPPLER_MODIFY_LIQUIDITY_EVENT,
            onLogs: (logs) => {
              for (const log of logs) resolveDopplerPoolId({ args: log.args as DopplerModifyLiquidityArgs });
            },
            onError: (err) => {
              deps.logger.warn({ err }, "robinhood adapter: Doppler ModifyLiquidity watch error — will resubscribe");
              lastTradeAddressKey = "";
            },
          });
        }

        if (pools.length > 0) {
          const ws = deps.createWsClient();
          tradeWatch.pons = ws.watchEvent({
            address: pools,
            event: PONS_V3_SWAP_EVENT,
            onLogs: onPonsSwapLogs,
            onError: (err) => {
              deps.logger.warn({ err }, "robinhood adapter: Pons swap watch error — will resubscribe");
              lastTradeAddressKey = "";
            },
          });
          void recoverGap({ label: "pons-swap", address: pools, event: PONS_V3_SWAP_EVENT, onLogs: onPonsSwapLogs });
        }
      }

      function resolveDopplerPoolId(log: { args: DopplerModifyLiquidityArgs }): void {
        const key = currencyPairKey(log.args.key.currency0, log.args.key.currency1);
        const tokenAddress = dopplerPairKeyToToken.get(key);
        if (!tokenAddress) return;
        const poolId = computeDopplerPoolId(log.args.key);
        dopplerPairKeyToToken.delete(key);
        dopplerPoolIdToToken.set(poolId.toLowerCase(), tokenAddress);
        dopplerResolvedTokens.add(tokenAddress.toLowerCase());
      }

      refresh();
      tradeResubscribeTimer = setInterval(refresh, resubscribeIntervalMs);
      tradeResubscribeTimer.unref?.();
    },

    async stopHotTradeFeed() {
      if (tradeResubscribeTimer) clearInterval(tradeResubscribeTimer);
      tradeResubscribeTimer = null;
      tradeWatch.doppler?.();
      tradeWatch.modifyLiquidity?.();
      tradeWatch.pons?.();
      tradeWatch = { doppler: null, pons: null, modifyLiquidity: null };
      lastTradeAddressKey = "";
    },

    async startHolderFeed(getHotAddresses, onTransfer) {
      function refresh(): void {
        const addresses = Array.from(new Set(getHotAddresses().map((a) => a.toLowerCase()))) as `0x${string}`[];
        const key = addresses.join(",");
        if (key === lastHolderAddressKey) return;
        lastHolderAddressKey = key;
        holderWatch?.();
        holderWatch = null;
        if (addresses.length === 0) return;
        const onTransferLogs = (logs: unknown[]): void => {
          for (const log of logs as { address: `0x${string}`; args: unknown; blockNumber: bigint; transactionHash: `0x${string}`; logIndex: number | null }[]) {
            trackBlock(log.blockNumber);
            const args = log.args as { from: `0x${string}`; to: `0x${string}`; value: bigint };
            onTransfer({
              chain: "robinhood",
              tokenAddress: log.address,
              from: args.from,
              to: args.to,
              amount: args.value,
              blockNumber: log.blockNumber,
              txHash: log.transactionHash,
              logIndex: log.logIndex ?? 0,
              timestamp: new Date(),
            });
          }
        };
        const ws = deps.createWsClient();
        holderWatch = ws.watchEvent({
          address: addresses,
          event: ERC20_TRANSFER_EVENT,
          onLogs: onTransferLogs,
          onError: (err) => {
            deps.logger.warn({ err }, "robinhood adapter: holder Transfer watch error — will resubscribe");
            lastHolderAddressKey = "";
          },
        });
        void recoverGap({ label: "holder-transfer", address: addresses, event: ERC20_TRANSFER_EVENT, onLogs: onTransferLogs });
      }
      refresh();
      holderResubscribeTimer = setInterval(refresh, resubscribeIntervalMs);
      holderResubscribeTimer.unref?.();
    },

    async stopHolderFeed() {
      if (holderResubscribeTimer) clearInterval(holderResubscribeTimer);
      holderResubscribeTimer = null;
      holderWatch?.();
      holderWatch = null;
      lastHolderAddressKey = "";
    },

    async backfillHolderTransfers(address, fromBlock, onTransfer) {
      const currentBlock = await deps.httpClient.getBlockNumber();
      for (const chunk of chunkBlockRange(fromBlock, currentBlock, chunkSize)) {
        const logs = await deps.httpClient.getLogs({
          address: address as `0x${string}`,
          event: ERC20_TRANSFER_EVENT,
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
        });
        for (const log of logs) {
          onTransfer({
            chain: "robinhood",
            tokenAddress: log.address,
            from: log.args.from as string,
            to: log.args.to as string,
            amount: log.args.value as bigint,
            blockNumber: log.blockNumber,
            txHash: log.transactionHash,
            logIndex: log.logIndex,
            timestamp: new Date(0), // backfilled logs don't carry a timestamp; caller resolves separately if needed
          });
        }
      }
    },

    async getTokenMetadata(address): Promise<TokenMetadata | null> {
      try {
        const addr = address as `0x${string}`;
        const [meta, decimals, totalSupply] = await Promise.all([
          resolveTokenMetadata(deps.httpClient, addr, deps.logger),
          resolveTokenDecimals(deps.httpClient, addr, deps.logger),
          deps.httpClient
            .readContract({ address: addr, abi: ERC20_TOTAL_SUPPLY_ABI, functionName: "totalSupply" })
            .then((v) => (typeof v === "bigint" ? v : null))
            .catch(() => null),
        ]);
        return { address, name: meta.name, symbol: meta.symbol, decimals, totalSupply };
      } catch (err) {
        deps.logger.warn({ err, address }, "robinhood adapter: getTokenMetadata failed");
        return null;
      }
    },

    async getCreator(address) {
      // Phase A/B scope: only ever knows a creator observed via this
      // adapter's own launch discovery (registerRouting) or backfill —
      // there is no cheap way to recover it for an arbitrary address
      // without re-scanning the Create/TokenLaunched logs from genesis.
      return routing.get(address.toLowerCase())?.creator ?? null;
    },

    async getLiquiditySnapshot(address): Promise<LiquiditySnapshot | null> {
      const token = routing.get(address.toLowerCase());
      if (!token) return null;
      // Honest, on-chain-first per B1.3: read the pool/initializer's actual
      // quote-token balance. No USD conversion here (Phase A/B has no
      // reliable on-chain ETH/USD price source) — liquidityUsd stays null
      // (UNKNOWN) rather than a guessed/DexScreener-primary number; B1.4
      // reserves DexScreener for secondary cross-check/fallback only, which
      // a later phase can wire in without changing this method's contract.
      const holder = token.source === "doppler" ? token.initializer : token.pool;
      if (!holder) return null;
      try {
        const liquidityNative = NATIVE_SENTINEL.test(token.pairToken)
          ? await deps.httpClient.getBalance({ address: holder as `0x${string}` })
          : ((await deps.httpClient.readContract({
              address: token.pairToken as `0x${string}`,
              abi: ERC20_BALANCE_OF_ABI,
              functionName: "balanceOf",
              args: [holder as `0x${string}`],
            })) as bigint);
        return {
          tokenAddress: address,
          liquidityNative,
          quoteToken: token.pairToken,
          liquidityUsd: null,
          source: "onchain",
          asOf: new Date(),
        };
      } catch (err) {
        deps.logger.warn({ err, address }, "robinhood adapter: getLiquiditySnapshot failed");
        return null;
      }
    },

    async simulateSellability(address, amountsUsd): Promise<SellabilityResult> {
      // Phase A/B: genuinely UNKNOWN for both launchpads. Doppler's
      // bonding-curve exit price is hook-controlled (no confirmed
      // read-only quote function found during Phase 0 investigation);
      // Pons V1 pools are standard Uniswap V3, but simulating an exact
      // exit requires a confirmed QuoterV2-style periphery contract
      // address on this chain, which Phase 0 did not confirm live. Never
      // fabricate PASS/FAIL without a real, verified read path — see spec
      // A.8/B2.6.
      const token = routing.get(address.toLowerCase());
      const reason =
        token?.source === "doppler"
          ? "no confirmed read-only exit-price function for Doppler's hook-controlled bonding curve"
          : "no confirmed Uniswap V3 Quoter contract address on this chain yet";
      return {
        status: "UNKNOWN",
        estimatedExitSlippagePctByUsd: Object.fromEntries(amountsUsd.map((usd) => [usd, null])),
        reasons: [reason],
      };
    },

    describeSources(): ChainSourceDescriptor[] {
      return [
        { source: "doppler", role: "airlock", address: deps.dopplerAirlockAddress, eventName: "Create" },
        { source: "pons_v1", role: "factory", address: deps.ponsV1FactoryAddress, eventName: "TokenLaunched" },
      ];
    },

    // B3 §5 observability — not part of the chain-agnostic ChainAdapter
    // contract (other chains don't have this shape of connection state),
    // hence the RobinhoodAdapter return type below rather than adding it to
    // ChainAdapter itself.
    getStatus(): RobinhoodAdapterStatus {
      return {
        connected: launchWatch?.isConnected() ?? false,
        lastKnownBlock,
        reconnectCount,
      };
    },
  };
}
