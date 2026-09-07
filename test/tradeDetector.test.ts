import { describe, expect, it, vi } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseAbiItem } from "viem";
import {
  computeDopplerPoolId,
  createTradeDetector,
  createTradeDetectorHttpClient,
  type DopplerModifyLiquidityArgs,
  type DopplerSwapArgs,
  type PonsSwapArgs,
  type TradeDetectorHttpClient,
  type TradeLog,
} from "../src/chain/tradeDetector.js";
import type { HttpClient } from "../src/chain/client.js";
import type { NewToken, TokensRepo, TrackedToken } from "../src/db/tokens.js";
import type { NewTrade, TradesRepo } from "../src/db/trades.js";
import type { WalletEntry } from "../src/db/walletWatchlist.js";
import type { WatchlistCache } from "../src/watchlist/watchlistCache.js";
import type { ResonanceDetector, WatchlistBuyEvent } from "../src/signals/resonanceDetector.js";
import type { Logger } from "../src/logger.js";

const CHAIN_ID = 4663;

// Native-currency numeraire (address 0x0) — always sorts as currency0/token0
// against any real token address, which keeps these fixtures unambiguous.
const NATIVE = "0x0000000000000000000000000000000000000000" as const;

// Real, on-chain-verified addresses (chainId 4663) — a live Doppler launch
// with a native-ETH numeraire, and its shared pool-initializer/hook contract.
const DOPPLER_ASSET = "0x91299ff153fD6bF3ee906C9333e572eA765D1E18" as const;
const DOPPLER_INITIALIZER = "0x4e3468951D49f2EEa976eD0D6e75fFCb44a9a544" as const;
const DOPPLER_LAUNCH_TX = "0xaaaa000000000000000000000000000000000000000000000000000000aaaa" as const;

// Real, on-chain-verified addresses for a live Pons V1 launch (BUNEE/WETH).
const PONS_ASSET = "0x055650555Be80649397084Cd3f8a09b4350e8612" as const;
const PONS_PAIR = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as const;
const PONS_POOL = "0x8f4F723f10fc7bAD28742d25c91158C728557C4c" as const;

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeTokensRepo(initial: TrackedToken[]): TokensRepo & { rows: TrackedToken[] } {
  const rows = initial;
  return {
    rows,
    async insertIfNew(_token: NewToken) {
      return true;
    },
    async countTokens() {
      return rows.length;
    },
    async listAll() {
      // Return copies so callers mutating a cached array (e.g. after
      // setPoolId) can't accidentally desync from what's "persisted" here.
      return rows.map((r) => ({ ...r }));
    },
    async setPoolId(tokenId, poolId) {
      const row = rows.find((r) => r.id === tokenId);
      if (row) row.poolId = poolId;
    },
  };
}

function fakeTradesRepo(): TradesRepo & { rows: NewTrade[] } {
  const rows: NewTrade[] = [];
  return {
    rows,
    async insertIfNew(trade) {
      const exists = rows.some(
        (r) => r.chainId === trade.chainId && r.txHash === trade.txHash && r.logIndex === trade.logIndex,
      );
      if (exists) return false;
      rows.push(trade);
      return true;
    },
    async countTrades() {
      return rows.length;
    },
    async listPendingUsdValue() {
      return [];
    },
    async setUsdValue() {
      // not exercised by these tests
    },
    async listByTokenAndWallets() {
      return [];
    },
    async countBuysByWallet() {
      return new Map();
    },
    async lastTradeAtByToken() {
      return new Map();
    },
    async countTotalBuysSells() {
      return { buys: 0, sells: 0 };
    },
    async hasWalletSold() {
      return false;
    },
    async getLargestSellUsdSince() {
      return null;
    },
    async getSellTotalsByWallets() {
      return new Map();
    },
    async listWalletActivityAggregates() {
      return new Map();
    },
    async listWalletTokenActivity30d() {
      return [];
    },
  };
}

function dopplerToken(overrides: Partial<TrackedToken> = {}): TrackedToken {
  return {
    id: 1,
    address: DOPPLER_ASSET,
    deployer: "0x1234567890123456789012345678901234567890",
    symbol: "TEST",
    name: "Test Token",
    launchSource: "doppler",
    pairToken: NATIVE,
    pool: DOPPLER_ASSET,
    launchBlock: 100n,
    launchTime: new Date("2026-01-01T00:00:00Z"),
    initializer: DOPPLER_INITIALIZER,
    poolId: null,
    ...overrides,
  };
}

function ponsToken(overrides: Partial<TrackedToken> = {}): TrackedToken {
  return {
    id: 2,
    address: PONS_ASSET,
    deployer: "0x1234567890123456789012345678901234567890",
    symbol: "PONS",
    name: "Pons Token",
    launchSource: "pons_v1",
    pairToken: PONS_PAIR,
    pool: PONS_POOL,
    launchBlock: 200n,
    launchTime: new Date("2026-01-01T00:00:00Z"),
    initializer: null,
    poolId: null,
    ...overrides,
  };
}

const DOPPLER_POOL_KEY = {
  currency0: NATIVE,
  currency1: DOPPLER_ASSET,
  fee: 8_388_608,
  tickSpacing: 8,
  hooks: DOPPLER_INITIALIZER,
};
const DOPPLER_POOL_ID = computeDopplerPoolId(DOPPLER_POOL_KEY);

function modifyLiquidityLog(): TradeLog<DopplerModifyLiquidityArgs> {
  return {
    args: {
      key: DOPPLER_POOL_KEY,
      params: { tickLower: -887272, tickUpper: 887272, liquidityDelta: 1_000_000n, salt: `0x${"0".repeat(64)}` },
    },
    address: DOPPLER_INITIALIZER,
    blockNumber: 100n,
    transactionHash: DOPPLER_LAUNCH_TX,
    logIndex: 3,
  };
}

function dopplerSwapLog(overrides: Partial<DopplerSwapArgs> = {}, logOverrides: Partial<TradeLog<unknown>> = {}) {
  return {
    args: {
      sender: "0x1234567890123456789012345678901234567890",
      poolId: DOPPLER_POOL_ID,
      params: { zeroForOne: true, amountSpecified: -5n, sqrtPriceLimitX96: 0n },
      amount0: -5n,
      amount1: 1000n,
      hookData: "0x",
      ...overrides,
    },
    address: DOPPLER_INITIALIZER,
    blockNumber: 105n,
    transactionHash: "0xbbbb000000000000000000000000000000000000000000000000000000bbbb",
    logIndex: 7,
    ...logOverrides,
  } as TradeLog<DopplerSwapArgs>;
}

function ponsSwapLog(overrides: Partial<PonsSwapArgs> = {}, logOverrides: Partial<TradeLog<unknown>> = {}) {
  return {
    args: {
      sender: "0x1234567890123456789012345678901234567890",
      recipient: "0x1234567890123456789012345678901234567890",
      amount0: -300n,
      amount1: 7n,
      sqrtPriceX96: 0n,
      liquidity: 0n,
      tick: 0,
      ...overrides,
    },
    address: PONS_POOL,
    blockNumber: 205n,
    transactionHash: "0xcccc000000000000000000000000000000000000000000000000000000cccc",
    logIndex: 4,
    ...logOverrides,
  } as TradeLog<PonsSwapArgs>;
}

const WALLET = "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" as const;

function fakeWatchlistCache(entries: WalletEntry[] = []): WatchlistCache {
  const byAddress = new Map(entries.map((e) => [e.address.toLowerCase(), e]));
  return {
    lookup: (address) => byAddress.get(address.toLowerCase()),
    refresh: async () => {},
    size: () => byAddress.size,
    entries: () => [...byAddress.values()],
  };
}

function fakeResonanceDetector(): ResonanceDetector & { events: WatchlistBuyEvent[] } {
  const events: WatchlistBuyEvent[] = [];
  return {
    events,
    async onWatchlistBuy(event) {
      events.push(event);
    },
    stop() {},
    getWindowEntryCount() {
      return 0;
    },
  };
}

function watchlistEntry(overrides: Partial<WalletEntry> = {}): WalletEntry {
  return {
    address: WALLET,
    name: "KOL_test",
    type: "KOL",
    tier: "A",
    ownerGroup: "test-owner",
    enabled: true,
    notes: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

function makeHttpClient(overrides: Partial<TradeDetectorHttpClient> = {}): TradeDetectorHttpClient {
  return {
    getDopplerModifyLiquidityLogs: vi.fn(async () => []),
    getDopplerSwapLogs: vi.fn(async () => []),
    getPonsSwapLogs: vi.fn(async () => []),
    resolveTradeWallet: vi.fn(async () => ({ wallet: WALLET, viaEntryPoint: false, resolvedViaUserOp: false })),
    getBlockTimestamp: vi.fn(async () => 1_700_000_000n),
    ...overrides,
  };
}

describe("TradeDetector — Doppler BUY parsing", () => {
  it("resolves the PoolId from the launch's ModifyLiquidity event and records a BUY", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken()]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getDopplerModifyLiquidityLogs: vi.fn(async () => [modifyLiquidityLog()]),
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog()]),
    });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger: fakeLogger(),
    });

    await detector.processBlockRange(100n, 105n);

    expect(tokensRepo.rows[0]?.poolId).toBe(DOPPLER_POOL_ID);
    expect(tradesRepo.rows).toHaveLength(1);
    expect(tradesRepo.rows[0]).toMatchObject({
      chainId: CHAIN_ID,
      tokenId: 1,
      wallet: WALLET,
      side: "BUY",
      quoteAmount: "5",
      tokenAmount: "1000",
      txHash: "0xbbbb000000000000000000000000000000000000000000000000000000bbbb",
      logIndex: 7,
    });
  });
});

describe("TradeDetector — Doppler SELL parsing", () => {
  it("records a SELL when the swapper's asset-side delta is negative", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog({ amount0: 9n, amount1: -2000n })]),
    });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger: fakeLogger(),
    });

    await detector.processBlockRange(105n, 105n);

    expect(tradesRepo.rows).toHaveLength(1);
    expect(tradesRepo.rows[0]).toMatchObject({ side: "SELL", quoteAmount: "9", tokenAmount: "2000" });
  });
});

describe("TradeDetector — Pons V1 BUY/SELL parsing", () => {
  it("records a BUY when the pool's asset-side delta is negative (pool paid the asset out)", async () => {
    const tokensRepo = fakeTokensRepo([ponsToken()]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getPonsSwapLogs: vi.fn(async () => [ponsSwapLog()]),
    });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger: fakeLogger(),
    });

    await detector.processBlockRange(205n, 205n);

    expect(tradesRepo.rows).toHaveLength(1);
    expect(tradesRepo.rows[0]).toMatchObject({
      tokenId: 2,
      side: "BUY",
      quoteAmount: "7",
      tokenAmount: "300",
    });
  });

  it("records a SELL when the pool's asset-side delta is positive (pool received the asset)", async () => {
    const tokensRepo = fakeTokensRepo([ponsToken()]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getPonsSwapLogs: vi.fn(async () => [ponsSwapLog({ amount0: 150n, amount1: -3n })]),
    });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger: fakeLogger(),
    });

    await detector.processBlockRange(205n, 205n);

    expect(tradesRepo.rows).toHaveLength(1);
    expect(tradesRepo.rows[0]).toMatchObject({ side: "SELL", quoteAmount: "3", tokenAmount: "150" });
  });
});

describe("TradeDetector — Transfer/airdrop exclusion", () => {
  it("never records a trade from a block range with no genuine Swap logs", async () => {
    // The http client only ever exposes Swap-shaped logs (getDopplerSwapLogs /
    // getPonsSwapLogs are built from an eth_getLogs call topic-filtered to the
    // Swap event selector), so plain ERC20 Transfer events — including
    // airdrops, which are just Transfers with no curve/pool interaction —
    // never reach the detector at all. A range with no Swap activity must
    // produce zero trades.
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID }), ponsToken()]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient();

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger: fakeLogger(),
    });

    await detector.processBlockRange(100n, 200n);

    expect(tradesRepo.rows).toHaveLength(0);
  });
});

describe("TradeDetector — duplicate (chain_id, tx_hash, log_index) handling", () => {
  it("does not insert the same trade twice when the same log is observed again", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog()]),
    });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger: fakeLogger(),
    });

    // Simulate the same swap log being observed twice (e.g. overlapping
    // restart-recovery windows).
    await detector.processBlockRange(105n, 105n);
    await detector.processBlockRange(105n, 105n);

    expect(tradesRepo.rows).toHaveLength(1);
  });
});

describe("TradeDetector — watch-address derivation", () => {
  it("queries Doppler/Pons swap logs scoped to the known initializer/pool addresses", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID }), ponsToken()]);
    const tradesRepo = fakeTradesRepo();
    const getDopplerSwapLogs = vi.fn(async () => []);
    const getPonsSwapLogs = vi.fn(async () => []);
    const httpClient = makeHttpClient({ getDopplerSwapLogs, getPonsSwapLogs });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger: fakeLogger(),
    });

    await detector.processBlockRange(300n, 300n);

    expect(getDopplerSwapLogs).toHaveBeenCalledWith({
      addresses: [DOPPLER_INITIALIZER],
      fromBlock: 300n,
      toBlock: 300n,
    });
    expect(getPonsSwapLogs).toHaveBeenCalledWith({
      addresses: [PONS_POOL],
      fromBlock: 300n,
      toBlock: 300n,
    });
  });
});

describe("TradeDetector — watchlist hit logging", () => {
  it("logs a watchlist hit when the trade's wallet is an enabled watched address", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog()]),
    });
    const logger = fakeLogger();
    const watched = watchlistEntry({ name: "KOL_张三", tier: "A", ownerGroup: "zhangsan" });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache([watched]),
      resonanceDetector: fakeResonanceDetector(),
      logger,
    });

    await detector.processBlockRange(105n, 105n);

    expect(tradesRepo.rows).toHaveLength(1);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        walletName: "KOL_张三",
        tier: "A",
        ownerGroup: "zhangsan",
        token: DOPPLER_ASSET,
        side: "BUY",
        quoteAmount: "5",
        tokenAmount: "1000",
      }),
      "watchlist wallet trade",
    );
  });

  it("does not log a watchlist hit for a wallet that isn't on the list", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog()]),
    });
    const logger = fakeLogger();

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache([]),
      resonanceDetector: fakeResonanceDetector(),
      logger,
    });

    await detector.processBlockRange(105n, 105n);

    expect(logger.info).not.toHaveBeenCalledWith(expect.anything(), "watchlist wallet trade");
  });
});

describe("TradeDetector — resonance detection integration", () => {
  it("notifies the resonance detector on a watchlist wallet's BUY", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog()]), // amount1=1000n -> BUY
    });
    const watched = watchlistEntry({ name: "KOL_test", tier: "A", ownerGroup: "owner-1" });
    const resonanceDetector = fakeResonanceDetector();

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache([watched]),
      resonanceDetector,
      logger: fakeLogger(),
    });

    await detector.processBlockRange(105n, 105n);

    expect(resonanceDetector.events).toHaveLength(1);
    expect(resonanceDetector.events[0]).toMatchObject({
      tokenId: 1,
      tokenAddress: DOPPLER_ASSET,
      wallet: watched,
      quoteAmount: 5n,
    });
  });

  it("does NOT notify the resonance detector on a watchlist wallet's SELL — only BUY counts", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog({ amount0: 9n, amount1: -2000n })]), // SELL
    });
    const watched = watchlistEntry();
    const resonanceDetector = fakeResonanceDetector();

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache([watched]),
      resonanceDetector,
      logger: fakeLogger(),
    });

    await detector.processBlockRange(105n, 105n);

    expect(tradesRepo.rows[0]?.side).toBe("SELL");
    expect(resonanceDetector.events).toHaveLength(0);
  });

  it("does NOT notify the resonance detector for a wallet absent from the watchlist cache (covers both 'not on the list' and 'enabled=false', since Phase 4's cache only ever holds enabled entries)", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog()]), // BUY, but wallet isn't watched
    });
    const resonanceDetector = fakeResonanceDetector();

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache([]),
      resonanceDetector,
      logger: fakeLogger(),
    });

    await detector.processBlockRange(105n, 105n);

    expect(resonanceDetector.events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// EIP-7702 / ERC-4337 EntryPoint wallet resolution
// ---------------------------------------------------------------------------

const ENTRY_POINT_V08 = "0x4337084d9e255ff0702461cf8895ce9e3b5ff108" as const;
const REAL_TRADER = "0x8f62a08537cede87d511aca6436274ab4ca080a3" as const; // DumbCrayonEater, real FOMO Top100 candidate address
const BUNDLER = "0x43370371e0bb085d04d02a815230aaf67b35ef25" as const; // real observed bundler tx.from

describe("TradeDetector — records the real UserOperation sender, not the bundler, for EntryPoint-routed trades", () => {
  it("uses resolveTradeWallet's wallet when viaEntryPoint=true, and logs info (not warn)", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const logger = fakeLogger();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog()]),
      resolveTradeWallet: vi.fn(async () => ({ wallet: REAL_TRADER, viaEntryPoint: true, resolvedViaUserOp: true })),
    });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger,
    });

    await detector.processBlockRange(105n, 105n);

    expect(tradesRepo.rows[0]?.wallet).toBe(REAL_TRADER);
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: REAL_TRADER }),
      expect.stringContaining("resolved to real UserOperation sender"),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("falls back to tx.from (the bundler) and logs a warn when no matching UserOperationEvent was found", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const logger = fakeLogger();
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog()]),
      resolveTradeWallet: vi.fn(async () => ({ wallet: BUNDLER, viaEntryPoint: true, resolvedViaUserOp: false })),
    });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger,
    });

    await detector.processBlockRange(105n, 105n);

    expect(tradesRepo.rows[0]?.wallet).toBe(BUNDLER);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ wallet: BUNDLER }),
      expect.stringContaining("no matching UserOperationEvent found"),
    );
  });

  it("passes the trade log's own logIndex to resolveTradeWallet, not some other value", async () => {
    const tokensRepo = fakeTokensRepo([dopplerToken({ poolId: DOPPLER_POOL_ID })]);
    const tradesRepo = fakeTradesRepo();
    const resolveTradeWallet = vi.fn(async () => ({ wallet: WALLET, viaEntryPoint: false, resolvedViaUserOp: false }));
    const httpClient = makeHttpClient({
      getDopplerSwapLogs: vi.fn(async () => [dopplerSwapLog({}, { logIndex: 42 })]),
      resolveTradeWallet,
    });

    const detector = createTradeDetector({
      chainId: CHAIN_ID,
      httpClient,
      tokensRepo,
      tradesRepo,
      watchlistCache: fakeWatchlistCache(),
      resonanceDetector: fakeResonanceDetector(),
      logger: fakeLogger(),
    });

    await detector.processBlockRange(105n, 105n);

    expect(resolveTradeWallet).toHaveBeenCalledWith(
      expect.objectContaining({ logIndex: 42, transactionHash: "0xbbbb000000000000000000000000000000000000000000000000000000bbbb" }),
    );
  });
});

const USER_OPERATION_EVENT_ABI = parseAbiItem(
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
);

function userOperationEventLog(params: {
  address?: `0x${string}`;
  sender: `0x${string}`;
  logIndex: number;
  userOpHash?: `0x${string}`;
}) {
  const userOpHash = params.userOpHash ?? (`0x${"1".repeat(64)}` as `0x${string}`);
  const topics = encodeEventTopics({
    abi: [USER_OPERATION_EVENT_ABI],
    eventName: "UserOperationEvent",
    args: { userOpHash, sender: params.sender, paymaster: "0x0000000000000000000000000000000000000000" },
  });
  const data = encodeAbiParameters(
    [
      { name: "nonce", type: "uint256" },
      { name: "success", type: "bool" },
      { name: "actualGasCost", type: "uint256" },
      { name: "actualGasUsed", type: "uint256" },
    ],
    [1n, true, 100n, 90n],
  );
  return { address: params.address ?? ENTRY_POINT_V08, topics, data, logIndex: params.logIndex } as const;
}

const TX_HASH = "0xdddd000000000000000000000000000000000000000000000000000000dddd" as const;

/** Minimal fake satisfying only the two viem PublicClient methods
 * createTradeDetectorHttpClient's resolveTradeWallet actually calls. */
function fakeViemClient(params: { from: `0x${string}`; to: `0x${string}` | null; receiptLogs?: unknown[] }): HttpClient {
  return {
    getTransaction: vi.fn(async () => ({ from: params.from, to: params.to })),
    getTransactionReceipt: vi.fn(async () => ({ logs: params.receiptLogs ?? [] })),
  } as unknown as HttpClient;
}

describe("createTradeDetectorHttpClient — resolveTradeWallet (real EIP-7702/ERC-4337 decoding logic)", () => {
  it("returns tx.from directly, with viaEntryPoint=false, when tx.to is not a known EntryPoint (the common, non-AA case)", async () => {
    const client = fakeViemClient({ from: BUNDLER, to: DOPPLER_INITIALIZER });
    const httpClient = createTradeDetectorHttpClient(client);

    const result = await httpClient.resolveTradeWallet({ transactionHash: TX_HASH, logIndex: 7 });

    expect(result).toEqual({ wallet: BUNDLER, viaEntryPoint: false, resolvedViaUserOp: false });
    expect(client.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it("resolves to the real UserOperation sender from the first UserOperationEvent after the trade log's logIndex", async () => {
    const client = fakeViemClient({
      from: BUNDLER,
      to: ENTRY_POINT_V08,
      receiptLogs: [userOperationEventLog({ sender: REAL_TRADER, logIndex: 8 })],
    });
    const httpClient = createTradeDetectorHttpClient(client);

    const result = await httpClient.resolveTradeWallet({ transactionHash: TX_HASH, logIndex: 7 });

    expect(result).toEqual({ wallet: REAL_TRADER, viaEntryPoint: true, resolvedViaUserOp: true });
  });

  it("separates two different real users batched into one handleOps call by picking the nearest following UserOperationEvent, never the tx-wide one", async () => {
    const SECOND_TRADER = "0xf75f2f708e489299c992349a73baec209b400aa0" as const; // real FOMO Top100 candidate (dreamloaderxo)
    const client = fakeViemClient({
      from: BUNDLER,
      to: ENTRY_POINT_V08,
      receiptLogs: [
        userOperationEventLog({ sender: REAL_TRADER, logIndex: 5 }), // op #1's event — precedes op #2's swap
        userOperationEventLog({ sender: SECOND_TRADER, logIndex: 12 }), // op #2's event
      ],
    });
    const httpClient = createTradeDetectorHttpClient(client);

    // A swap log between the two UserOperationEvents belongs to op #2, not op #1.
    const result = await httpClient.resolveTradeWallet({ transactionHash: TX_HASH, logIndex: 9 });

    expect(result.wallet).toBe(SECOND_TRADER);
  });

  it("falls back to tx.from and reports resolvedViaUserOp=false when tx.to is an EntryPoint but no matching event follows the log", async () => {
    const client = fakeViemClient({
      from: BUNDLER,
      to: ENTRY_POINT_V08,
      receiptLogs: [userOperationEventLog({ sender: REAL_TRADER, logIndex: 3 })], // only precedes our log, doesn't follow it
    });
    const httpClient = createTradeDetectorHttpClient(client);

    const result = await httpClient.resolveTradeWallet({ transactionHash: TX_HASH, logIndex: 7 });

    expect(result).toEqual({ wallet: BUNDLER, viaEntryPoint: true, resolvedViaUserOp: false });
  });

  it("ignores a non-UserOperationEvent log at the EntryPoint address rather than crashing or misattributing", async () => {
    const client = fakeViemClient({
      from: BUNDLER,
      to: ENTRY_POINT_V08,
      receiptLogs: [
        { address: ENTRY_POINT_V08, topics: [`0x${"9".repeat(64)}` as `0x${string}`], data: "0x", logIndex: 8 },
        userOperationEventLog({ sender: REAL_TRADER, logIndex: 9 }),
      ],
    });
    const httpClient = createTradeDetectorHttpClient(client);

    const result = await httpClient.resolveTradeWallet({ transactionHash: TX_HASH, logIndex: 7 });

    expect(result).toEqual({ wallet: REAL_TRADER, viaEntryPoint: true, resolvedViaUserOp: true });
  });
});
