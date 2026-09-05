import { describe, expect, it } from "vitest";
import { createWatchlistCache, countDistinctOwnerGroups } from "../src/watchlist/watchlistCache.js";
import type { WalletEntry, WalletFilter, WalletWatchlistRepo } from "../src/db/walletWatchlist.js";
import type { Logger } from "../src/logger.js";

function fakeLogger(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

function entry(overrides: Partial<WalletEntry> = {}): WalletEntry {
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

function fakeRepo(rows: WalletEntry[]): WalletWatchlistRepo {
  return {
    async list(filter?: WalletFilter) {
      return rows.filter((w) => filter?.enabled === undefined || w.enabled === filter.enabled);
    },
    create: async () => null,
    update: async () => null,
    remove: async () => false,
    upsert: async (e) => ({ address: e.address.toLowerCase(), inserted: true }),
    countEnabled: async () => rows.filter((w) => w.enabled).length,
  };
}

describe("WatchlistCache", () => {
  it("finds a cached wallet by address, case-insensitively, only after refresh", async () => {
    const wallet = entry({ address: "0xAbCdEfabcdefabcdefabcdefabcdefabcdefabcd" });
    const cache = createWatchlistCache(fakeRepo([wallet]), fakeLogger());

    expect(cache.lookup("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")).toBeUndefined();

    await cache.refresh();

    expect(cache.lookup("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")).toEqual(wallet);
    expect(cache.lookup("0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD")).toEqual(wallet);
    expect(cache.size()).toBe(1);
  });

  it("only caches enabled wallets", async () => {
    const disabled = entry({ address: "0x111111111111111111111111111111111111111a", enabled: false });
    const cache = createWatchlistCache(fakeRepo([disabled]), fakeLogger());

    await cache.refresh();

    expect(cache.lookup(disabled.address)).toBeUndefined();
    expect(cache.size()).toBe(0);
  });

  it("drops a wallet from the cache after a refresh once it's no longer enabled", async () => {
    const wallet = entry({ address: "0x222222222222222222222222222222222222222b" });
    const rows = [wallet];
    const cache = createWatchlistCache(fakeRepo(rows), fakeLogger());

    await cache.refresh();
    expect(cache.lookup(wallet.address)).toBeDefined();

    rows[0] = { ...wallet, enabled: false };
    await cache.refresh();
    expect(cache.lookup(wallet.address)).toBeUndefined();
  });
});

describe("countDistinctOwnerGroups", () => {
  it("counts multiple wallets from the same owner as one", () => {
    const wallets = [
      entry({ address: "0x111111111111111111111111111111111111111a", ownerGroup: "zhangsan" }),
      entry({ address: "0x222222222222222222222222222222222222222b", ownerGroup: "zhangsan" }),
      entry({ address: "0x333333333333333333333333333333333333333c", ownerGroup: "lisi" }),
    ];

    expect(countDistinctOwnerGroups(wallets)).toBe(2);
  });

  it("returns 0 for an empty list", () => {
    expect(countDistinctOwnerGroups([])).toBe(0);
  });
});
