import { describe, expect, it } from "vitest";
import { TokenMarketState, computeAcceleration } from "../../src/hotradar/marketState.js";
import type { TradeEvent } from "../../src/chains/types.js";

function trade(overrides: Partial<TradeEvent> & { timestamp: Date }): TradeEvent {
  return {
    chain: "robinhood",
    tokenAddress: "0xtoken",
    wallet: "0xwallet1",
    side: "BUY",
    quoteAmount: 100n,
    tokenAmount: 1000n,
    usdValue: 10,
    blockNumber: 1n,
    txHash: "0xtx",
    logIndex: 0,
    ...overrides,
  };
}

describe("TokenMarketState — partial windows (B2.4)", () => {
  it("returns null (not 0) for a window with zero trades", () => {
    const state = new TokenMarketState();
    const snapshot = state.snapshot(Date.now());
    expect(snapshot.windows["1m"].volume).toBeNull();
    expect(snapshot.windows["1m"].buys).toBeNull();
  });

  it("age < 1m: only the 1m window has data, 3m/5m still see it too since they're supersets", () => {
    const t0 = Date.now();
    const state = new TokenMarketState();
    state.recordTrade(trade({ timestamp: new Date(t0), wallet: "0xa", usdValue: 10 }), null);
    const snapshot = state.snapshot(t0 + 5_000);
    expect(snapshot.windows["1m"].buys).toBe(1);
    expect(snapshot.windows["3m"].buys).toBe(1);
    expect(snapshot.windows["5m"].buys).toBe(1);
  });
});

describe("TokenMarketState — buy/sell/unique aggregation", () => {
  it("counts buys, sells, unique buyers/sellers/traders correctly", () => {
    const t0 = Date.now();
    const state = new TokenMarketState();
    state.recordTrade(trade({ timestamp: new Date(t0), wallet: "0xa", side: "BUY", usdValue: 10 }), null);
    state.recordTrade(trade({ timestamp: new Date(t0 + 1000), wallet: "0xb", side: "BUY", usdValue: 20 }), null);
    state.recordTrade(trade({ timestamp: new Date(t0 + 2000), wallet: "0xa", side: "SELL", usdValue: 5 }), null);

    const snapshot = state.snapshot(t0 + 3000);
    const w = snapshot.windows["1m"];
    expect(w.buys).toBe(2);
    expect(w.sells).toBe(1);
    expect(w.uniqueBuyers).toBe(2);
    expect(w.uniqueSellers).toBe(1);
    expect(w.uniqueTraders).toBe(2); // 0xa buys+sells, still one distinct trader
    expect(w.volume).toBe(35);
    expect(w.netBuyFlow).toBe(25); // 30 buy - 5 sell
  });

  it("evicts trades older than the 5m window", () => {
    const t0 = Date.now();
    const state = new TokenMarketState();
    state.recordTrade(trade({ timestamp: new Date(t0), wallet: "0xa" }), null);
    state.recordTrade(trade({ timestamp: new Date(t0 + 6 * 60_000) }), null);
    const snapshot = state.snapshot(t0 + 6 * 60_000);
    expect(snapshot.windows["5m"].buys).toBe(1); // only the second trade survives
  });
});

describe("TokenMarketState — velocity (never fabricated from one sample)", () => {
  it("volumeVelocity is null on the very first snapshot (no prior sample to compare)", () => {
    const t0 = Date.now();
    const state = new TokenMarketState();
    state.recordTrade(trade({ timestamp: new Date(t0), usdValue: 10 }), null);
    expect(state.snapshot(t0 + 1000).volumeVelocity).toBeNull();
  });

  it("computes a real velocity from two successive non-empty snapshots", () => {
    const t0 = Date.now();
    const state = new TokenMarketState();
    state.recordTrade(trade({ timestamp: new Date(t0), usdValue: 10 }), null);
    state.snapshot(t0 + 1000); // first sample, seeds lastVolume1m

    state.recordTrade(trade({ timestamp: new Date(t0 + 2000), usdValue: 10 }), null);
    const second = state.snapshot(t0 + 3000);
    expect(second.volumeVelocity).not.toBeNull();
    expect(second.volumeVelocity!).toBeGreaterThan(0); // volume grew
  });
});

describe("computeAcceleration", () => {
  it("is null when either velocity sample is missing", () => {
    expect(computeAcceleration(null, 0.5)).toBeNull();
    expect(computeAcceleration(0.5, null)).toBeNull();
  });

  it("is the delta between two real velocity samples", () => {
    expect(computeAcceleration(0.2, 0.5)).toBeCloseTo(0.3);
  });
});
