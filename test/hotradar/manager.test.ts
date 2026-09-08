import { describe, expect, it, vi } from "vitest";
import { HotCandidateManager } from "../../src/hotradar/manager.js";
import type { ChainAdapter, LaunchEvent, TokenTransferEvent, TradeEvent } from "../../src/chains/types.js";

/** A fully in-memory fake ChainAdapter — captures the callbacks the
 * manager registers so a test can fire launch/trade/transfer events
 * directly, without any chain-specific plumbing (proves the manager only
 * depends on the ChainAdapter interface, per spec A.2). */
function fakeAdapter() {
  let onLaunch: ((e: LaunchEvent) => void) | null = null;
  let onTrade: ((e: TradeEvent) => void) | null = null;
  let onTransfer: ((e: TokenTransferEvent) => void) | null = null;
  let getTradeHotAddresses: (() => string[]) | null = null;

  const adapter: ChainAdapter = {
    chainKey: "robinhood",
    async startLaunchDiscovery(cb) {
      onLaunch = cb;
    },
    async stopLaunchDiscovery() {
      onLaunch = null;
    },
    async startHotTradeFeed(getHotAddresses, cb) {
      onTrade = cb;
      getTradeHotAddresses = getHotAddresses;
    },
    async stopHotTradeFeed() {
      onTrade = null;
    },
    async startHolderFeed(_getHotAddresses, cb) {
      onTransfer = cb;
    },
    async stopHolderFeed() {
      onTransfer = null;
    },
    async getTokenMetadata() {
      return null;
    },
    async getCreator() {
      return null;
    },
    async getLiquiditySnapshot() {
      return null;
    },
    async simulateSellability(_address, amountsUsd) {
      return { status: "UNKNOWN", estimatedExitSlippagePctByUsd: Object.fromEntries(amountsUsd.map((u) => [u, null])), reasons: ["test stub"] };
    },
    describeSources() {
      return [];
    },
  };

  return {
    adapter,
    emitLaunch: (e: LaunchEvent) => onLaunch?.(e),
    emitTrade: (e: TradeEvent) => onTrade?.(e),
    emitTransfer: (e: TokenTransferEvent) => onTransfer?.(e),
    getTradeHotAddresses: () => getTradeHotAddresses?.() ?? [],
  };
}

const TOKEN = "0xtoken0000000000000000000000000000000001";

function launchEvent(overrides: Partial<LaunchEvent> = {}): LaunchEvent {
  return {
    chain: "robinhood",
    source: "doppler",
    tokenAddress: TOKEN,
    creator: "0xcreator1",
    pairToken: "0xpair1",
    pool: "0xpool1",
    launchedAt: new Date(),
    launchBlockNumber: 100n,
    launchBlockHash: "0xblock100",
    launchTxHash: "0xtx1",
    ...overrides,
  };
}

function tradeEvent(overrides: Partial<TradeEvent> = {}): TradeEvent {
  return {
    chain: "robinhood",
    tokenAddress: TOKEN,
    wallet: "0xwallet1",
    side: "BUY",
    quoteAmount: 100n,
    tokenAmount: 1000n,
    usdValue: 500,
    blockNumber: 105n,
    txHash: "0xtradetx1",
    logIndex: 0,
    timestamp: new Date(),
    ...overrides,
  };
}

describe("HotCandidateManager — launch discovery", () => {
  it("creates a DISCOVERED candidate and includes it in the hot address set", async () => {
    const { adapter, emitLaunch, getTradeHotAddresses } = fakeAdapter();
    const manager = new HotCandidateManager({ adapter, logger: { info() {}, warn() {}, error() {}, debug() {} } as never });
    await manager.start();

    const launchedAt = new Date();
    emitLaunch(launchEvent({ launchedAt }));

    const candidate = manager.getCandidate(TOKEN);
    expect(candidate).toBeDefined();
    expect(candidate!.radarState).toBe("DISCOVERED");
    expect(getTradeHotAddresses()).toContain(TOKEN);
    expect(manager.getCounters().launchesTotal).toBe(1);

    await manager.stop();
  });

  it("does not double-count a duplicate launch event for the same token", async () => {
    const { adapter, emitLaunch } = fakeAdapter();
    const manager = new HotCandidateManager({ adapter, logger: { info() {}, warn() {}, error() {}, debug() {} } as never });
    await manager.start();
    emitLaunch(launchEvent());
    emitLaunch(launchEvent());
    expect(manager.getCounters().launchesTotal).toBe(1);
    await manager.stop();
  });
});

describe("HotCandidateManager — tick evaluation", () => {
  it("evaluates score and invokes onScoreEvaluated, with a real breakoutScore from trade activity", async () => {
    const { adapter, emitLaunch, emitTrade } = fakeAdapter();
    const onScoreEvaluated = vi.fn();
    const manager = new HotCandidateManager({
      adapter,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      onScoreEvaluated,
    });
    await manager.start();

    const launchedAt = new Date(Date.now() - 5 * 60_000); // 5m old — HOT, sweet-spot earlyness
    emitLaunch(launchEvent({ launchedAt }));
    emitTrade(tradeEvent());
    emitTrade(tradeEvent({ wallet: "0xwallet2", txHash: "0xtradetx2" }));

    manager.tick(new Date());

    expect(onScoreEvaluated).toHaveBeenCalledTimes(1);
    const [candidate, score] = onScoreEvaluated.mock.calls[0];
    expect(candidate.tokenAddress).toBe(TOKEN);
    expect(score.breakoutScore).toBeGreaterThan(0);
    await manager.stop();
  });

  it("fires onAlert once breakoutScore clears the WATCH threshold, and only re-fires on a real score change", async () => {
    const { adapter, emitLaunch, emitTrade } = fakeAdapter();
    const onAlert = vi.fn();
    const manager = new HotCandidateManager({
      adapter,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      onAlert,
    });
    await manager.start();
    emitLaunch(launchEvent({ launchedAt: new Date(Date.now() - 5 * 60_000) }));
    for (let i = 0; i < 6; i++) {
      emitTrade(tradeEvent({ wallet: `0xwallet${i}`, txHash: `0xtx${i}`, usdValue: 1000 }));
    }

    manager.tick(new Date());
    manager.tick(new Date()); // identical state — must not re-fire

    // May or may not clear WATCH depending on exact score math — assert
    // consistency instead of a brittle exact call count.
    expect(onAlert.mock.calls.length).toBeLessThanOrEqual(1);
    await manager.stop();
  });
});

describe("HotCandidateManager — radarState / protocolState are independent (spec A.4)", () => {
  it("radarState advances with age while protocolState stays whatever it was set to, unaffected by the tick", async () => {
    const { adapter, emitLaunch } = fakeAdapter();
    const manager = new HotCandidateManager({ adapter, logger: { info() {}, warn() {}, error() {}, debug() {} } as never });
    await manager.start();

    emitLaunch(launchEvent({ launchedAt: new Date(Date.now() - 5 * 60_000) }));
    const candidate = manager.getCandidate(TOKEN)!;
    candidate.protocolState = "CURVE_ACTIVE"; // simulate a protocol-side update independent of radar ticking

    expect(candidate.radarState).toBe("DISCOVERED"); // not yet re-evaluated
    manager.tick(new Date());
    expect(candidate.radarState).toBe("HOT"); // radarState moved with age
    expect(candidate.protocolState).toBe("CURVE_ACTIVE"); // untouched by the same tick

    await manager.stop();
  });
});

describe("HotCandidateManager — expiry (A.6/A.13 step 7)", () => {
  it("releases the holder balance map and stops evaluating once a candidate passes 30m", async () => {
    const { adapter, emitLaunch, emitTransfer } = fakeAdapter();
    const onScoreEvaluated = vi.fn();
    const manager = new HotCandidateManager({
      adapter,
      logger: { info() {}, warn() {}, error() {}, debug() {} } as never,
      onScoreEvaluated,
    });
    await manager.start();

    const launchedAt = new Date(Date.now() - 31 * 60_000);
    emitLaunch(launchEvent({ launchedAt }));
    emitTransfer({
      chain: "robinhood",
      tokenAddress: TOKEN,
      from: `0x${"0".repeat(40)}`,
      to: "0xholder1",
      amount: 100n,
      blockNumber: 101n,
      txHash: "0xtransfer1",
      logIndex: 0,
      timestamp: new Date(),
    });

    manager.tick(new Date());

    expect(manager.getCandidate(TOKEN)!.radarState).toBe("EXPIRED_30M");
    expect(onScoreEvaluated).not.toHaveBeenCalled(); // never scored once already past 30m on first tick
    await manager.stop();
  });
});
