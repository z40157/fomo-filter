import { describe, expect, it } from "vitest";
import { computeRepeatBuyerCount, computeWatchedAggregates } from "../src/market/candidateAggregates.js";
import type { WalletEntry } from "../src/db/walletWatchlist.js";

function walletEntry(overrides: Partial<WalletEntry> = {}): WalletEntry {
  return {
    address: "0x1234567890123456789012345678901234567890",
    name: "KOL_test",
    type: "KOL",
    tier: "A",
    ownerGroup: "owner-1",
    enabled: true,
    notes: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("computeWatchedAggregates", () => {
  it("counts BUY-side hits, sums known usdValue, and dedups owners by ownerGroup", () => {
    const walletA = walletEntry({ address: "0xaaa", ownerGroup: "zhangsan" });
    const walletB = walletEntry({ address: "0xbbb", ownerGroup: "zhangsan" }); // same owner as A
    const walletC = walletEntry({ address: "0xccc", ownerGroup: "lisi" });
    const byAddress = new Map([
      [walletA.address, walletA],
      [walletB.address, walletB],
      [walletC.address, walletC],
    ]);

    const result = computeWatchedAggregates(
      [
        { wallet: "0xaaa", side: "BUY", usdValue: 100 },
        { wallet: "0xbbb", side: "BUY", usdValue: 200 },
        { wallet: "0xccc", side: "SELL", usdValue: 50 },
      ],
      (address) => byAddress.get(address),
    );

    expect(result.watchedWalletBuyCount).toBe(2);
    expect(result.independentOwnerCount).toBe(1); // A and B are the same owner
    expect(result.aggregateWatchedBuyUsd).toBe(300);
    expect(result.aggregateWatchedSellUsd).toBe(50);
  });

  it("treats a null usdValue as not-yet-known — it contributes 0, not NaN or a guess", () => {
    const wallet = walletEntry({ address: "0xaaa" });
    const result = computeWatchedAggregates(
      [{ wallet: "0xaaa", side: "BUY", usdValue: null }],
      () => wallet,
    );
    expect(result.watchedWalletBuyCount).toBe(1);
    expect(result.aggregateWatchedBuyUsd).toBe(0);
  });

  it("ignores rows for wallets the lookup can't resolve", () => {
    const result = computeWatchedAggregates(
      [{ wallet: "0xunknown", side: "BUY", usdValue: 100 }],
      () => undefined,
    );
    expect(result.watchedWalletBuyCount).toBe(0);
    expect(result.independentOwnerCount).toBe(0);
  });
});

describe("computeRepeatBuyerCount", () => {
  it("counts wallets with 2+ buys, regardless of watchlist membership", () => {
    const buyCounts = new Map([
      ["0xaaa", 3],
      ["0xbbb", 1],
      ["0xccc", 2],
    ]);
    expect(computeRepeatBuyerCount(buyCounts)).toBe(2);
  });

  it("returns 0 for an empty map", () => {
    expect(computeRepeatBuyerCount(new Map())).toBe(0);
  });
});
