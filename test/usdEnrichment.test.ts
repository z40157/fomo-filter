import { describe, expect, it, vi } from "vitest";
import { computeUsdValue, createUsdEnrichmentJob } from "../src/market/usdEnrichment.js";
import type { PendingUsdValueTrade, TradesRepo } from "../src/db/trades.js";
import type { TokenSnapshotsRepo } from "../src/db/tokenSnapshots.js";
import type { Logger } from "../src/logger.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeTradesRepo(pending: PendingUsdValueTrade[]): TradesRepo & { updates: Map<number, number> } {
  const updates = new Map<number, number>();
  return {
    updates,
    insertIfNew: async () => true,
    countTrades: async () => 0,
    listPendingUsdValue: async () => pending,
    async setUsdValue(tradeId, usdValue) {
      updates.set(tradeId, usdValue);
    },
    listByTokenAndWallets: async () => [],
    countBuysByWallet: async () => new Map(),
    lastTradeAtByToken: async () => new Map(),
  };
}

describe("computeUsdValue", () => {
  it("converts a raw base-unit tokenAmount to human units before multiplying by price", () => {
    // 1 token (18 decimals) at $0.05
    expect(computeUsdValue("1000000000000000000", 18, 0.05)).toBeCloseTo(0.05);
  });

  it("handles non-18 decimals correctly", () => {
    // 1 token (6 decimals) at $2.00
    expect(computeUsdValue("1000000", 6, 2)).toBeCloseTo(2);
  });
});

describe("usdEnrichment — uses the nearest historical snapshot, not the current price", () => {
  it("picks the snapshot findNearestPriceBefore returns, not some other price", async () => {
    const pending: PendingUsdValueTrade[] = [
      { id: 1, tokenId: 10, tokenAddress: "0xtoken", tokenAmount: "1000000000000000000", timestamp: new Date("2026-01-01T00:00:00Z") },
    ];
    const tradesRepo = fakeTradesRepo(pending);
    const findNearestPriceBefore = vi.fn(async () => ({ price: 0.1 })); // the historical price at trade time
    const snapshotsRepo: TokenSnapshotsRepo = {
      insert: async () => {},
      findNearestPriceBefore,
    };

    const job = createUsdEnrichmentJob({
      tradesRepo,
      snapshotsRepo,
      decimalsResolver: { resolveDecimals: async () => 18 },
      logger: fakeLogger(),
    });

    const result = await job.runOnce();

    expect(findNearestPriceBefore).toHaveBeenCalledWith(10, pending[0]!.timestamp, expect.any(Number));
    expect(result.updated).toBe(1);
    expect(tradesRepo.updates.get(1)).toBeCloseTo(0.1); // 1 token * $0.1, not whatever "today's price" might be
  });

  it("leaves usdValue null (skips) when no snapshot is close enough in time — never guesses using a distant price", async () => {
    const pending: PendingUsdValueTrade[] = [
      { id: 1, tokenId: 10, tokenAddress: "0xtoken", tokenAmount: "1000000000000000000", timestamp: new Date() },
    ];
    const tradesRepo = fakeTradesRepo(pending);
    const snapshotsRepo: TokenSnapshotsRepo = {
      insert: async () => {},
      findNearestPriceBefore: async () => null, // nothing close enough
    };

    const job = createUsdEnrichmentJob({
      tradesRepo,
      snapshotsRepo,
      decimalsResolver: { resolveDecimals: async () => 18 },
      logger: fakeLogger(),
    });

    const result = await job.runOnce();

    expect(result.updated).toBe(0);
    expect(result.skippedNoSnapshot).toBe(1);
    expect(tradesRepo.updates.size).toBe(0);
  });

  it("skips (does not guess 18) when decimals() can't be resolved", async () => {
    const pending: PendingUsdValueTrade[] = [
      { id: 1, tokenId: 10, tokenAddress: "0xtoken", tokenAmount: "1000000000000000000", timestamp: new Date() },
    ];
    const tradesRepo = fakeTradesRepo(pending);
    const snapshotsRepo: TokenSnapshotsRepo = {
      insert: async () => {},
      findNearestPriceBefore: async () => ({ price: 1 }),
    };

    const job = createUsdEnrichmentJob({
      tradesRepo,
      snapshotsRepo,
      decimalsResolver: { resolveDecimals: async () => null },
      logger: fakeLogger(),
    });

    const result = await job.runOnce();

    expect(result.updated).toBe(0);
    expect(result.skippedNoDecimals).toBe(1);
  });

  it("caches decimals across trades of the same token within a run", async () => {
    const pending: PendingUsdValueTrade[] = [
      { id: 1, tokenId: 10, tokenAddress: "0xtoken", tokenAmount: "1000000000000000000", timestamp: new Date() },
      { id: 2, tokenId: 10, tokenAddress: "0xtoken", tokenAmount: "2000000000000000000", timestamp: new Date() },
    ];
    const tradesRepo = fakeTradesRepo(pending);
    const snapshotsRepo: TokenSnapshotsRepo = {
      insert: async () => {},
      findNearestPriceBefore: async () => ({ price: 1 }),
    };
    const resolveDecimals = vi.fn(async () => 18);

    const job = createUsdEnrichmentJob({
      tradesRepo,
      snapshotsRepo,
      decimalsResolver: { resolveDecimals },
      logger: fakeLogger(),
    });

    await job.runOnce();

    expect(resolveDecimals).toHaveBeenCalledTimes(1);
  });
});
