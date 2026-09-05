import { describe, expect, it } from "vitest";
import {
  aggregateCandidates,
  findEarlyBuyersByCount,
  findEarlyBuyersByTime,
  percentileRanks,
  scoreTokens,
  type PerTokenEarlyBuyers,
  type TokenTradeStats,
  type TradeForMining,
} from "../scripts/lib/mining.js";

describe("percentileRanks", () => {
  it("ranks values from 0 (lowest) to 1 (highest)", () => {
    expect(percentileRanks([10, 30, 20])).toEqual([0, 1, 0.5]);
  });

  it("gives every value rank 1 when there's only one element (or none to compare against)", () => {
    expect(percentileRanks([42])).toEqual([1]);
    expect(percentileRanks([])).toEqual([]);
  });
});

function tokenStats(overrides: Partial<TokenTradeStats> = {}): TokenTradeStats {
  return {
    tokenId: 1,
    address: "0x1234567890123456789012345678901234567890",
    symbol: "TEST",
    totalTrades: 10,
    uniqueBuyers: 5,
    buys: 6,
    sells: 4,
    firstTradeAt: new Date("2026-01-01T00:00:00Z"),
    lastTradeAt: new Date("2026-01-01T01:00:00Z"),
    netInflowRaw: 100,
    ...overrides,
  };
}

describe("scoreTokens", () => {
  it("scores the token with strictly better metrics on every axis higher", () => {
    const weak = tokenStats({
      tokenId: 1,
      totalTrades: 10,
      uniqueBuyers: 2,
      buys: 5,
      sells: 5,
      lastTradeAt: new Date("2026-01-01T00:10:00Z"),
      netInflowRaw: -50,
    });
    const strong = tokenStats({
      tokenId: 2,
      totalTrades: 100,
      uniqueBuyers: 40,
      buys: 90,
      sells: 10,
      lastTradeAt: new Date("2026-01-02T00:00:00Z"),
      netInflowRaw: 5000,
    });

    const [scoredWeak, scoredStrong] = scoreTokens([weak, strong]);
    expect(scoredStrong!.score).toBeGreaterThan(scoredWeak!.score);
    expect(scoredStrong!.score).toBe(1);
    expect(scoredWeak!.score).toBe(0);
  });

  it("computes buyRatio as buys / (buys + sells)", () => {
    const [scored] = scoreTokens([tokenStats({ buys: 3, sells: 1 })]);
    expect(scored!.buyRatio).toBeCloseTo(0.75);
  });
});

describe("findEarlyBuyersByCount", () => {
  it("only considers the first N trades and only BUY sides, first occurrence per wallet", () => {
    const trades: TradeForMining[] = [
      { wallet: "0xaaa", side: "SELL", timestamp: new Date(0) },
      { wallet: "0xbbb", side: "BUY", timestamp: new Date(1) },
      { wallet: "0xbbb", side: "BUY", timestamp: new Date(2) }, // second buy, should not overwrite the first rank
      { wallet: "0xccc", side: "BUY", timestamp: new Date(3) }, // outside topN=2 window (index 3)
    ];

    const hits = findEarlyBuyersByCount(trades, 3);
    expect(hits).toEqual([{ wallet: "0xbbb", rankAmongFirstN: 2 }]);
  });
});

describe("findEarlyBuyersByTime", () => {
  it("only considers BUYs within the time window of the first trade", () => {
    const first = new Date("2026-01-01T00:00:00Z").getTime();
    const trades: TradeForMining[] = [
      { wallet: "0xaaa", side: "BUY", timestamp: new Date(first) },
      { wallet: "0xbbb", side: "BUY", timestamp: new Date(first + 10 * 60_000) },
      { wallet: "0xccc", side: "BUY", timestamp: new Date(first + 45 * 60_000) }, // outside 30-min window
    ];

    const hits = findEarlyBuyersByTime(trades, 30);
    expect(hits).toEqual([
      { wallet: "0xaaa", minutesAfterFirstTrade: 0 },
      { wallet: "0xbbb", minutesAfterFirstTrade: 10 },
    ]);
  });

  it("returns nothing for an empty trade list", () => {
    expect(findEarlyBuyersByTime([], 30)).toEqual([]);
  });
});

describe("aggregateCandidates", () => {
  it("counts hitCount as the union of both criteria, and tracks per-criterion counts separately", () => {
    const perToken: PerTokenEarlyBuyers[] = [
      {
        tokenAddress: "0xTOKEN1",
        symbol: "TOK1",
        byCount: [{ wallet: "0xaaa", rankAmongFirstN: 1 }],
        byTime: [{ wallet: "0xaaa", minutesAfterFirstTrade: 0 }],
      },
      {
        tokenAddress: "0xTOKEN2",
        symbol: "TOK2",
        byCount: [{ wallet: "0xaaa", rankAmongFirstN: 5 }],
        byTime: [],
      },
    ];

    const [candidate] = aggregateCandidates(perToken);
    expect(candidate!.address).toBe("0xaaa");
    expect(candidate!.hitCount).toBe(2); // 2 distinct tokens, not 3 hits
    expect(candidate!.hitCountTopN).toBe(2);
    expect(candidate!.hitCountTimeWindow).toBe(1);
    expect(candidate!.avgEntryRank).toBe(3); // (1 + 5) / 2
    expect(candidate!.avgEntryMinutes).toBe(0);
  });

  it("gives distinct wallets their own entries", () => {
    const perToken: PerTokenEarlyBuyers[] = [
      {
        tokenAddress: "0xTOKEN1",
        symbol: "TOK1",
        byCount: [
          { wallet: "0xaaa", rankAmongFirstN: 1 },
          { wallet: "0xbbb", rankAmongFirstN: 2 },
        ],
        byTime: [],
      },
    ];

    const candidates = aggregateCandidates(perToken);
    expect(candidates).toHaveLength(2);
  });
});
