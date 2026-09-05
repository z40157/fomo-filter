import { describe, expect, it } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createLogger } from "../src/logger.js";
import type { WalletWatchlistRepo } from "../src/db/walletWatchlist.js";
import type { WatchlistCache } from "../src/watchlist/watchlistCache.js";

function fakeWalletsRepo(): WalletWatchlistRepo {
  return {
    list: async () => [],
    create: async () => null,
    update: async () => null,
    remove: async () => false,
    upsert: async (entry) => ({ address: entry.address.toLowerCase(), inserted: true }),
    countEnabled: async () => 0,
  };
}

function fakeWatchlistCache(watchedWallets: number): WatchlistCache {
  return {
    lookup: () => undefined,
    refresh: async () => {},
    size: () => watchedWallets,
    entries: () => [],
  };
}

describe("GET /health", () => {
  it("returns 200 with real watcher/database/tokens/wallets/candidate/signal status", async () => {
    const app = buildServer({
      logger: createLogger("silent"),
      chainId: 4663,
      watcher: { getStatus: () => ({ wsConnected: true, lastBlock: 12345n }) },
      checkDatabase: async () => "ok",
      countTrackedTokens: async () => 7,
      walletsRepo: fakeWalletsRepo(),
      watchlistCache: fakeWatchlistCache(3),
      adminApiKey: "test-admin-key",
      countActiveCandidates: () => 12,
      getDexScreenerStatus: () => "ok",
      countSignalsToday: async () => 5,
      getLastSignalAt: async () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      chainId: 4663,
      wsConnected: true,
      lastBlock: 12345,
      database: "ok",
      trackedTokens: 7,
      watchedWallets: 3,
      activeCandidates: 12,
      dexscreenerStatus: "ok",
      signalsToday: 5,
      lastSignalAt: "2026-01-01T00:00:00.000Z",
    });

    await app.close();
  });

  it("reports database errors, a null lastBlock, and no signals yet", async () => {
    const app = buildServer({
      logger: createLogger("silent"),
      chainId: 4663,
      watcher: { getStatus: () => ({ wsConnected: false, lastBlock: null }) },
      checkDatabase: async () => "error",
      countTrackedTokens: async () => 0,
      walletsRepo: fakeWalletsRepo(),
      watchlistCache: fakeWatchlistCache(0),
      adminApiKey: "test-admin-key",
      countActiveCandidates: () => 0,
      getDexScreenerStatus: () => "down",
      countSignalsToday: async () => 0,
      getLastSignalAt: async () => null,
    });

    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.json()).toEqual({
      status: "ok",
      chainId: 4663,
      wsConnected: false,
      lastBlock: null,
      database: "error",
      trackedTokens: 0,
      watchedWallets: 0,
      activeCandidates: 0,
      dexscreenerStatus: "down",
      signalsToday: 0,
      lastSignalAt: null,
    });

    await app.close();
  });
});
