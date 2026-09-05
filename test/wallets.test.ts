import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../src/api/server.js";
import { createLogger } from "../src/logger.js";
import type {
  NewWalletEntry,
  WalletEntry,
  WalletFilter,
  WalletPatch,
  WalletWatchlistRepo,
} from "../src/db/walletWatchlist.js";
import type { WatchlistCache } from "../src/watchlist/watchlistCache.js";

const ADMIN_KEY = "correct-admin-key";

function toEntry(entry: NewWalletEntry): WalletEntry {
  return {
    address: entry.address.toLowerCase(),
    name: entry.name,
    type: entry.type,
    tier: entry.tier,
    ownerGroup: entry.ownerGroup,
    enabled: entry.enabled ?? true,
    notes: entry.notes ?? null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function fakeWalletsRepo(): WalletWatchlistRepo & { rows: Map<string, WalletEntry> } {
  const rows = new Map<string, WalletEntry>();
  return {
    rows,
    async list(filter?: WalletFilter) {
      return [...rows.values()].filter(
        (w) =>
          (filter?.type === undefined || w.type === filter.type) &&
          (filter?.tier === undefined || w.tier === filter.tier) &&
          (filter?.enabled === undefined || w.enabled === filter.enabled),
      );
    },
    async create(entry: NewWalletEntry) {
      const address = entry.address.toLowerCase();
      if (rows.has(address)) return null;
      const created = toEntry(entry);
      rows.set(address, created);
      return created;
    },
    async update(address: string, patch: WalletPatch) {
      const lower = address.toLowerCase();
      const existing = rows.get(lower);
      if (!existing) return null;
      const updated = { ...existing, ...patch, updatedAt: new Date() };
      rows.set(lower, updated);
      return updated;
    },
    async remove(address: string) {
      return rows.delete(address.toLowerCase());
    },
    async upsert(entry: NewWalletEntry) {
      const address = entry.address.toLowerCase();
      const inserted = !rows.has(address);
      rows.set(address, toEntry(entry));
      return { address, inserted };
    },
    async countEnabled() {
      return [...rows.values()].filter((w) => w.enabled).length;
    },
  };
}

function fakeWatchlistCache(): WatchlistCache {
  return { lookup: () => undefined, refresh: vi.fn(async () => {}), size: () => 0, entries: () => [] };
}

function buildApp(walletsRepo: WalletWatchlistRepo, watchlistCache: WatchlistCache = fakeWatchlistCache()) {
  return buildServer({
    logger: createLogger("silent"),
    chainId: 4663,
    watcher: { getStatus: () => ({ wsConnected: true, lastBlock: 1n }) },
    checkDatabase: async () => "ok",
    countTrackedTokens: async () => 0,
    walletsRepo,
    watchlistCache,
    adminApiKey: ADMIN_KEY,
    countActiveCandidates: () => 0,
    getDexScreenerStatus: () => "ok",
  });
}

const VALID_WALLET: NewWalletEntry = {
  address: "0x1234567890123456789012345678901234567890",
  name: "KOL_test",
  type: "KOL",
  tier: "A",
  ownerGroup: "test-owner",
};

describe("POST /api/wallets — admin auth", () => {
  it("returns 401 without an x-admin-key header", async () => {
    const app = buildApp(fakeWalletsRepo());
    const response = await app.inject({ method: "POST", url: "/api/wallets", payload: VALID_WALLET });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 with a wrong x-admin-key header", async () => {
    const app = buildApp(fakeWalletsRepo());
    const response = await app.inject({
      method: "POST",
      url: "/api/wallets",
      headers: { "x-admin-key": "wrong-key" },
      payload: VALID_WALLET,
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("succeeds with the correct x-admin-key header", async () => {
    const repo = fakeWalletsRepo();
    const app = buildApp(repo);
    const response = await app.inject({
      method: "POST",
      url: "/api/wallets",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: VALID_WALLET,
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ address: VALID_WALLET.address, name: "KOL_test" });
    expect(repo.rows.size).toBe(1);
    await app.close();
  });
});

describe("PATCH/DELETE /api/wallets/:address — admin auth", () => {
  it("PATCH returns 401 without an x-admin-key header", async () => {
    const app = buildApp(fakeWalletsRepo());
    const response = await app.inject({
      method: "PATCH",
      url: `/api/wallets/${VALID_WALLET.address}`,
      payload: { tier: "B" },
    });
    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it("DELETE returns 401 without an x-admin-key header", async () => {
    const app = buildApp(fakeWalletsRepo());
    const response = await app.inject({ method: "DELETE", url: `/api/wallets/${VALID_WALLET.address}` });
    expect(response.statusCode).toBe(401);
    await app.close();
  });
});

describe("Address case-insensitivity", () => {
  it("treats 0xABC... and 0xabc... as the same address — no duplicate row", async () => {
    const repo = fakeWalletsRepo();
    const app = buildApp(repo);

    const lower = { ...VALID_WALLET, address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" };
    const upper = { ...VALID_WALLET, address: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD" };

    const first = await app.inject({
      method: "POST",
      url: "/api/wallets",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: lower,
    });
    expect(first.statusCode).toBe(201);

    const second = await app.inject({
      method: "POST",
      url: "/api/wallets",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: upper,
    });
    expect(second.statusCode).toBe(409);
    expect(repo.rows.size).toBe(1);

    await app.close();
  });
});

describe("POST /api/wallets — validation", () => {
  it("rejects an invalid type with 400 and a clear message", async () => {
    const app = buildApp(fakeWalletsRepo());
    const response = await app.inject({
      method: "POST",
      url: "/api/wallets",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { ...VALID_WALLET, type: "NOT_A_TYPE" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/type/);
    await app.close();
  });

  it("rejects an invalid tier with 400 and a clear message", async () => {
    const app = buildApp(fakeWalletsRepo());
    const response = await app.inject({
      method: "POST",
      url: "/api/wallets",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { ...VALID_WALLET, tier: "Z" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/tier/);
    await app.close();
  });

  it("rejects a malformed address with 400", async () => {
    const app = buildApp(fakeWalletsRepo());
    const response = await app.inject({
      method: "POST",
      url: "/api/wallets",
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { ...VALID_WALLET, address: "not-an-address" },
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});

describe("GET /api/wallets", () => {
  it("requires no admin key and supports filtering", async () => {
    const repo = fakeWalletsRepo();
    await repo.create({ ...VALID_WALLET, type: "KOL", tier: "A" });
    await repo.create({
      address: "0x1234567890123456789012345678901234567891",
      name: "SmartMoney_01",
      type: "SMART_MONEY",
      tier: "B",
      ownerGroup: "sm01",
    });
    const app = buildApp(repo);

    const all = await app.inject({ method: "GET", url: "/api/wallets" });
    expect(all.statusCode).toBe(200);
    expect(all.json().wallets).toHaveLength(2);

    const filtered = await app.inject({ method: "GET", url: "/api/wallets?type=KOL" });
    expect(filtered.json().wallets).toHaveLength(1);
    expect(filtered.json().wallets[0].type).toBe("KOL");

    await app.close();
  });
});

describe("PATCH/DELETE /api/wallets/:address — success paths", () => {
  it("updates a wallet's fields and refreshes the watchlist cache", async () => {
    const repo = fakeWalletsRepo();
    await repo.create(VALID_WALLET);
    const cache = fakeWatchlistCache();
    const app = buildApp(repo, cache);

    const response = await app.inject({
      method: "PATCH",
      url: `/api/wallets/${VALID_WALLET.address}`,
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { tier: "C", enabled: false },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tier: "C", enabled: false });
    expect(cache.refresh).toHaveBeenCalled();
    await app.close();
  });

  it("removes a wallet and refreshes the watchlist cache", async () => {
    const repo = fakeWalletsRepo();
    await repo.create(VALID_WALLET);
    const cache = fakeWatchlistCache();
    const app = buildApp(repo, cache);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/wallets/${VALID_WALLET.address}`,
      headers: { "x-admin-key": ADMIN_KEY },
    });

    expect(response.statusCode).toBe(204);
    expect(repo.rows.size).toBe(0);
    expect(cache.refresh).toHaveBeenCalled();
    await app.close();
  });

  it("returns 404 when patching a wallet that doesn't exist", async () => {
    const app = buildApp(fakeWalletsRepo());
    const response = await app.inject({
      method: "PATCH",
      url: `/api/wallets/${VALID_WALLET.address}`,
      headers: { "x-admin-key": ADMIN_KEY },
      payload: { tier: "B" },
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
