import { encodeAbiParameters, keccak256, parseAbiItem, ResponseBodyTooLargeError } from "viem";
import type { Logger } from "../logger.js";
import type { NewTrade, TradeSide, TradesRepo } from "../db/trades.js";
import type { TokensRepo, TrackedToken } from "../db/tokens.js";
import type { WatchlistCache } from "../watchlist/watchlistCache.js";
import type { ResonanceDetector } from "../signals/resonanceDetector.js";
import type { HttpClient } from "./client.js";
import { chunkBlockRange } from "./newTokenDetector.js";

// Doppler bonding-curve trades do NOT go through the launched token contract
// (which only ever emits standard ERC20 Transfer/Approval — verified by
// pulling every raw log for several real launched tokens on-chain: no
// Buy/Sell/Swap topic ever appears there). Trading instead happens on the
// shared pool-initializer/hook contract named by the Airlock `Create`
// event's `initializer` field, which re-emits its own Swap event for
// Uniswap v4 PoolManager swaps. Verified against
// github.com/whetstoneresearch/doppler
// (src/initializers/DopplerHookInitializer.sol), independently computing
// this event's topic0 and confirming it's exactly the topic seen on 3,477
// real logs at that contract on-chain (chainId 4663), then decoding several
// real swaps and cross-checking the settled amount against the actual
// tx.value of a native-ETH-quoted trade.
export const DOPPLER_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) indexed poolKey, bytes32 indexed poolId, (bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) params, int128 amount0, int128 amount1, bytes hookData)",
);

// Same contract's ModifyLiquidity event carries the *unhashed* PoolKey,
// which is how we learn a launch's real `fee`/`tickSpacing` (the fee flag
// 0x800000 is constant across every launch, since it's forced by the
// hook's dynamic-fee design, but tickSpacing genuinely varies per launch —
// confirmed by finding both tickSpacing=8 and tickSpacing=200 among 1,644
// real ModifyLiquidity logs — so it must be read from chain, never assumed).
export const DOPPLER_MODIFY_LIQUIDITY_EVENT = parseAbiItem(
  "event ModifyLiquidity((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt) params)",
);

// Pons V1 launches seed a one-sided position on a real, standard Uniswap V3
// pool (github.com/ponsdotdev/ponsfamily contractsV1/src/PonsLaunchFactory.sol
// — "seed a one-sided Uniswap V3 position" — created via the registered
// `IUniswapV3FactoryLike`). Its Swap event is the standard, unmodified
// Uniswap V3 pool ABI; verified by decoding real recent swaps on several
// Pons-launched pools and confirming token0()/token1() plus sane, real
// WETH-denominated amounts.
export const PONS_V3_SWAP_EVENT = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
);

export interface PoolKeyArgs {
  currency0: `0x${string}`;
  currency1: `0x${string}`;
  fee: number;
  tickSpacing: number;
  hooks: `0x${string}`;
}

export interface DopplerModifyLiquidityArgs {
  key: PoolKeyArgs;
  params: { tickLower: number; tickUpper: number; liquidityDelta: bigint; salt: `0x${string}` };
}

export interface DopplerSwapArgs {
  sender: `0x${string}`;
  poolId: `0x${string}`;
  params: { zeroForOne: boolean; amountSpecified: bigint; sqrtPriceLimitX96: bigint };
  amount0: bigint;
  amount1: bigint;
  hookData: `0x${string}`;
}

export interface PonsSwapArgs {
  sender: `0x${string}`;
  recipient: `0x${string}`;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

export interface TradeLog<TArgs> {
  args: TArgs;
  /** Contract address that emitted this log — needed because we watch many pools/hooks at once. */
  address: `0x${string}`;
  blockNumber: bigint;
  transactionHash: `0x${string}`;
  logIndex: number;
}

/** Minimal, hand-shaped RPC surface the trade detector needs — kept
 * independent of viem's generic client types so it stays easy to mock. */
export interface TradeDetectorHttpClient {
  getDopplerModifyLiquidityLogs: (args: {
    addresses: `0x${string}`[];
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<TradeLog<DopplerModifyLiquidityArgs>[]>;
  getDopplerSwapLogs: (args: {
    addresses: `0x${string}`[];
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<TradeLog<DopplerSwapArgs>[]>;
  getPonsSwapLogs: (args: {
    addresses: `0x${string}`[];
    fromBlock: bigint;
    toBlock: bigint;
  }) => Promise<TradeLog<PonsSwapArgs>[]>;
  getTransactionSender: (hash: `0x${string}`) => Promise<`0x${string}`>;
  getBlockTimestamp: (blockNumber: bigint) => Promise<bigint>;
}

const POOL_KEY_ABI_PARAM = {
  type: "tuple",
  components: [
    { name: "currency0", type: "address" },
    { name: "currency1", type: "address" },
    { name: "fee", type: "uint24" },
    { name: "tickSpacing", type: "int24" },
    { name: "hooks", type: "address" },
  ],
} as const;

/** Uniswap v4 PoolId = keccak256(abi.encode(PoolKey)). Verified against a
 * real ModifyLiquidity log's key and the matching indexed poolId topic on a
 * Swap log from the same transaction. */
export function computeDopplerPoolId(key: PoolKeyArgs): `0x${string}` {
  return keccak256(encodeAbiParameters([POOL_KEY_ABI_PARAM], [key]));
}

/**
 * The 10,000-block cap is QuickNode's *range* limit, but a single call
 * within that range can still return a response too large for viem's
 * client-side size cap during a burst of activity — confirmed live: a
 * 10,000-block Doppler-hook window during a busy stretch returned 10.5MB
 * against viem's 10MB default. Rather than shrinking the default chunk
 * size (and paying for extra requests during the far more common quiet
 * periods), bisect and retry only the specific range that was too big.
 */
async function getLogsWithSizeBackoff<T>(
  fetchRange: (fromBlock: bigint, toBlock: bigint) => Promise<T[]>,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<T[]> {
  try {
    return await fetchRange(fromBlock, toBlock);
  } catch (err) {
    if (err instanceof ResponseBodyTooLargeError && toBlock > fromBlock) {
      const midBlock = fromBlock + (toBlock - fromBlock) / 2n;
      const [left, right] = await Promise.all([
        getLogsWithSizeBackoff(fetchRange, fromBlock, midBlock),
        getLogsWithSizeBackoff(fetchRange, midBlock + 1n, toBlock),
      ]);
      return [...left, ...right];
    }
    throw err;
  }
}

/** Wraps a real viem PublicClient into the minimal shape above. */
export function createTradeDetectorHttpClient(client: HttpClient): TradeDetectorHttpClient {
  return {
    async getDopplerModifyLiquidityLogs({ addresses, fromBlock, toBlock }) {
      if (addresses.length === 0) return [];
      const logs = await getLogsWithSizeBackoff(
        (from, to) =>
          client.getLogs({ address: addresses, event: DOPPLER_MODIFY_LIQUIDITY_EVENT, fromBlock: from, toBlock: to }),
        fromBlock,
        toBlock,
      );
      return logs.map((log) => ({
        args: log.args as DopplerModifyLiquidityArgs,
        address: log.address,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      }));
    },

    async getDopplerSwapLogs({ addresses, fromBlock, toBlock }) {
      if (addresses.length === 0) return [];
      const logs = await getLogsWithSizeBackoff(
        (from, to) => client.getLogs({ address: addresses, event: DOPPLER_SWAP_EVENT, fromBlock: from, toBlock: to }),
        fromBlock,
        toBlock,
      );
      return logs.map((log) => ({
        args: log.args as DopplerSwapArgs,
        address: log.address,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      }));
    },

    async getPonsSwapLogs({ addresses, fromBlock, toBlock }) {
      if (addresses.length === 0) return [];
      const logs = await getLogsWithSizeBackoff(
        (from, to) => client.getLogs({ address: addresses, event: PONS_V3_SWAP_EVENT, fromBlock: from, toBlock: to }),
        fromBlock,
        toBlock,
      );
      return logs.map((log) => ({
        args: log.args as PonsSwapArgs,
        address: log.address,
        blockNumber: log.blockNumber,
        transactionHash: log.transactionHash,
        logIndex: log.logIndex,
      }));
    },

    async getTransactionSender(hash) {
      const tx = await client.getTransaction({ hash });
      return tx.from;
    },

    async getBlockTimestamp(blockNumber) {
      const block = await client.getBlock({ blockNumber });
      return block.timestamp;
    },
  };
}

export interface TradeDetectorDeps {
  chainId: number;
  httpClient: TradeDetectorHttpClient;
  tokensRepo: TokensRepo;
  tradesRepo: TradesRepo;
  watchlistCache: WatchlistCache;
  resonanceDetector: ResonanceDetector;
  logger: Logger;
  /** Max block span per getLogs call. Default 10,000 (QuickNode Build plan's limit for this chain). */
  maxLogsBlockRange?: bigint;
}

export interface TradeDetector {
  processBlockRange: (fromBlock: bigint, toBlock: bigint) => Promise<void>;
}

function sortCurrencies(a: string, b: string): [string, string] {
  return BigInt(a) < BigInt(b) ? [a, b] : [b, a];
}

function distinctAddresses(addresses: (string | null)[]): `0x${string}`[] {
  const seen = new Set<string>();
  const result: `0x${string}`[] = [];
  for (const address of addresses) {
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(address as `0x${string}`);
  }
  return result;
}

function absDecimalString(value: bigint): string {
  return (value < 0n ? -value : value).toString();
}

export function createTradeDetector(deps: TradeDetectorDeps): TradeDetector {
  const chunkSize = deps.maxLogsBlockRange ?? 10_000n;

  function currencyPairKey(a: string, b: string): string {
    const [lo, hi] = sortCurrencies(a, b);
    return `${lo.toLowerCase()}_${hi.toLowerCase()}`;
  }

  /** A Doppler bonding-curve pool's liquidity isn't seeded at launch — it's
   * modified lazily, in the same transaction as whichever swap first trades
   * it (verified on-chain: a token's first ModifyLiquidity landed 97 blocks
   * after its Create event, in the exact same tx as its first real Swap).
   * So a token's PoolId can only be learned by watching ModifyLiquidity
   * logs in the same block range being scanned for trades — not by looking
   * near its launch block, and not by assuming fee/tickSpacing, since
   * tickSpacing genuinely varies per launch (confirmed: both 8 and 200 seen
   * across real launches). Untraded tokens simply stay unresolved, which is
   * correct — they have no trades to find yet. */
  async function resolvePoolIdFromModifyLiquidity(
    log: TradeLog<DopplerModifyLiquidityArgs>,
    pairKeyToToken: Map<string, TrackedToken>,
    poolIdToToken: Map<string, TrackedToken>,
  ): Promise<void> {
    const key = currencyPairKey(log.args.key.currency0, log.args.key.currency1);
    const token = pairKeyToToken.get(key);
    if (!token) return;

    const poolId = computeDopplerPoolId(log.args.key);
    pairKeyToToken.delete(key);
    poolIdToToken.set(poolId.toLowerCase(), token);
    token.poolId = poolId;
    try {
      await deps.tokensRepo.setPoolId(token.id, poolId);
      deps.logger.info({ token: token.address, poolId }, "resolved Doppler PoolId");
    } catch (err) {
      deps.logger.error({ err, token: token.address }, "failed to persist resolved Doppler PoolId");
    }
  }

  async function recordTrade(params: {
    token: TrackedToken;
    side: TradeSide;
    tokenAmount: bigint;
    quoteAmount: bigint;
    blockNumber: bigint;
    transactionHash: `0x${string}`;
    logIndex: number;
  }): Promise<void> {
    try {
      const [wallet, timestamp] = await Promise.all([
        deps.httpClient.getTransactionSender(params.transactionHash),
        deps.httpClient.getBlockTimestamp(params.blockNumber),
      ]);

      const trade: NewTrade = {
        chainId: deps.chainId,
        tokenId: params.token.id,
        wallet,
        side: params.side,
        quoteAmount: absDecimalString(params.quoteAmount),
        tokenAmount: absDecimalString(params.tokenAmount),
        blockNumber: params.blockNumber,
        txHash: params.transactionHash,
        logIndex: params.logIndex,
        timestamp: new Date(Number(timestamp) * 1000),
      };
      const inserted = await deps.tradesRepo.insertIfNew(trade);
      if (inserted) {
        deps.logger.info(
          { token: params.token.address, side: params.side, wallet, tx: params.transactionHash },
          "trade recorded",
        );

        const watched = deps.watchlistCache.lookup(wallet);
        if (watched) {
          deps.logger.info(
            {
              walletName: watched.name,
              tier: watched.tier,
              ownerGroup: watched.ownerGroup,
              token: params.token.address,
              side: params.side,
              quoteAmount: trade.quoteAmount,
              tokenAmount: trade.tokenAmount,
              tx: params.transactionHash,
            },
            "watchlist wallet trade",
          );

          if (params.side === "BUY") {
            await deps.resonanceDetector.onWatchlistBuy({
              tokenId: params.token.id,
              tokenAddress: params.token.address,
              tokenSymbol: params.token.symbol,
              wallet: watched,
              quoteAmount: BigInt(trade.quoteAmount),
              timestamp: trade.timestamp,
            });
          }
        }
      } else {
        deps.logger.debug(
          { tx: params.transactionHash, logIndex: params.logIndex },
          "trade already recorded, skipping duplicate",
        );
      }
    } catch (err) {
      deps.logger.error({ err, tx: params.transactionHash }, "failed to process trade log");
    }
  }

  async function handleDopplerSwap(
    log: TradeLog<DopplerSwapArgs>,
    poolIdToToken: Map<string, TrackedToken>,
  ): Promise<void> {
    const token = poolIdToToken.get(log.args.poolId.toLowerCase());
    if (!token) return;

    const [currency0] = sortCurrencies(token.address, token.pairToken);
    const assetIsCurrency0 = currency0.toLowerCase() === token.address.toLowerCase();
    // Doppler's Swap event reports the *swapper's* balance delta (verified
    // against a real native-ETH trade: amount0 exactly matched -tx.value):
    // positive = swapper received that currency, negative = swapper paid it.
    const tokenAmount = assetIsCurrency0 ? log.args.amount0 : log.args.amount1;
    const quoteAmount = assetIsCurrency0 ? log.args.amount1 : log.args.amount0;
    const side: TradeSide = tokenAmount > 0n ? "BUY" : "SELL";

    await recordTrade({
      token,
      side,
      tokenAmount,
      quoteAmount,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    });
  }

  async function handlePonsSwap(
    log: TradeLog<PonsSwapArgs>,
    poolToToken: Map<string, TrackedToken>,
  ): Promise<void> {
    const token = poolToToken.get(log.address.toLowerCase());
    if (!token) return;

    const [token0] = sortCurrencies(token.address, token.pairToken);
    const assetIsToken0 = token0.toLowerCase() === token.address.toLowerCase();
    // Standard Uniswap V3 Swap event reports the *pool's* balance delta
    // (verified against real trades on a live Pons pool): positive = pool
    // received that currency (swapper paid it in), negative = pool paid it
    // out (swapper received it) — the opposite convention from Doppler's hook.
    const tokenAmount = assetIsToken0 ? log.args.amount0 : log.args.amount1;
    const quoteAmount = assetIsToken0 ? log.args.amount1 : log.args.amount0;
    const side: TradeSide = tokenAmount < 0n ? "BUY" : "SELL";

    await recordTrade({
      token,
      side,
      tokenAmount,
      quoteAmount,
      blockNumber: log.blockNumber,
      transactionHash: log.transactionHash,
      logIndex: log.logIndex,
    });
  }

  return {
    async processBlockRange(fromBlock, toBlock) {
      const allTokens = await deps.tokensRepo.listAll();
      const dopplerTokens = allTokens.filter((t) => t.launchSource === "doppler");
      const ponsTokens = allTokens.filter((t) => t.launchSource === "pons_v1");

      const initializerAddresses = distinctAddresses(dopplerTokens.map((t) => t.initializer));
      const pairKeyToToken = new Map(
        dopplerTokens
          .filter((t) => t.poolId === null)
          .map((t) => [currencyPairKey(t.address, t.pairToken), t] as const),
      );
      const poolIdToToken = new Map(
        dopplerTokens.filter((t) => t.poolId !== null).map((t) => [t.poolId!.toLowerCase(), t] as const),
      );

      for (const chunk of chunkBlockRange(fromBlock, toBlock, chunkSize)) {
        if (initializerAddresses.length > 0 && pairKeyToToken.size > 0) {
          const modifyLiquidityLogs = await deps.httpClient.getDopplerModifyLiquidityLogs({
            addresses: initializerAddresses,
            fromBlock: chunk.fromBlock,
            toBlock: chunk.toBlock,
          });
          for (const log of modifyLiquidityLogs) {
            await resolvePoolIdFromModifyLiquidity(log, pairKeyToToken, poolIdToToken);
          }
        }

        const swaps = await deps.httpClient.getDopplerSwapLogs({
          addresses: initializerAddresses,
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
        });
        for (const log of swaps) {
          await handleDopplerSwap(log, poolIdToToken);
        }
      }

      const poolAddresses = distinctAddresses(ponsTokens.map((t) => t.pool));
      const poolToToken = new Map(ponsTokens.map((t) => [t.pool.toLowerCase(), t] as const));

      for (const chunk of chunkBlockRange(fromBlock, toBlock, chunkSize)) {
        const swaps = await deps.httpClient.getPonsSwapLogs({
          addresses: poolAddresses,
          fromBlock: chunk.fromBlock,
          toBlock: chunk.toBlock,
        });
        for (const log of swaps) {
          await handlePonsSwap(log, poolToToken);
        }
      }
    },
  };
}
