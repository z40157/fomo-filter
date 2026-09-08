import { describe, expect, it, vi } from "vitest";
import {
  createWalletDiscoveryJob,
  type AddressCodeClient,
  type WalletDiscoveryJobDeps,
} from "../../src/discovery/walletDiscoveryJob.js";
import type { DiscoveryCandidateToken, DiscoveryRepo, DiscoverySnapshotRow, DiscoveryTradeRow } from "../../src/db/discovery.js";
import type { NewWalletEntry, WalletEntry, WalletWatchlistRepo } from "../../src/db/walletWatchlist.js";
import type { Logger } from "../../src/logger.js";
import type { TelegramClient } from "../../src/alerts/telegramClient.js";
import type { WatchlistCache } from "../../src/watchlist/watchlistCache.js";

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

function fakeWatchlistCache(): WatchlistCache {
  return { lookup: () => undefined, refresh: vi.fn(async () => {}), size: () => 0, entries: () => [] };
}

function memWalletsRepo(seed: WalletEntry[] = []): WalletWatchlistRepo {
  const rows = [...seed];
  return {
    async list() {
      return [...rows];
    },
    async create(entry: NewWalletEntry) {
      const address = entry.address.toLowerCase();
      if (rows.some((r) => r.address === address)) return null;
      const created: WalletEntry = {
        address,
        name: entry.name,
        type: entry.type,
        tier: entry.tier,
        ownerGroup: entry.ownerGroup,
        enabled: entry.enabled ?? false,
        notes: entry.notes ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      rows.push(created);
      return created;
    },
    async update() {
      return null;
    },
    async remove() {
      return false;
    },
    async upsert(entry) {
      return { address: entry.address.toLowerCase(), inserted: true };
    },
    async countEnabled() {
      return rows.filter((r) => r.enabled).length;
    },
  };
}

interface FakeToken {
  tokenId: number;
  address: string;
  symbol: string | null;
  minTrades: number;
  snapshots: DiscoverySnapshotRow[];
  trades: DiscoveryTradeRow[];
}

function fakeDiscoveryRepo(tokens: FakeToken[], infra: string[] = []): DiscoveryRepo {
  return {
    async listCandidateTokens(): Promise<DiscoveryCandidateToken[]> {
      return tokens.map((t) => ({ tokenId: t.tokenId, address: t.address, symbol: t.symbol }));
    },
    async listTokenSnapshotPrices(tokenId) {
      return tokens.find((t) => t.tokenId === tokenId)?.snapshots ?? [];
    },
    async listTradesForToken(tokenId) {
      return tokens.find((t) => t.tokenId === tokenId)?.trades ?? [];
    },
    async listInfrastructureAddresses() {
      return new Set(infra.map((a) => a.toLowerCase()));
    },
  };
}

function snaps(prices: number[]): DiscoverySnapshotRow[] {
  return prices.map((price, i) => ({ price, snapshotAt: new Date(2026, 0, 1, i) }));
}

function trade(wallet: string, side: "BUY" | "SELL", minute: number): DiscoveryTradeRow {
  return { wallet: wallet.toLowerCase(), side, timestamp: new Date(2026, 0, 1, 0, minute) };
}

const WALLET_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const WALLET_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const WALLET_CONTRACT = "0xcccccccccccccccccccccccccccccccccccccc";
const WALLET_EIP7702 = "0xdddddddddddddddddddddddddddddddddddddd";

const EIP7702_CODE = "0xef0100e6cae83bde06e4c305530e199d7217f42808555b";

function baseDeps(overrides: Partial<WalletDiscoveryJobDeps> = {}): WalletDiscoveryJobDeps {
  const performingToken: FakeToken = {
    tokenId: 1,
    address: "0x1111111111111111111111111111111111111111",
    symbol: "MOON",
    minTrades: 3,
    snapshots: snaps([1, 2, 5, 10, 20]),
    trades: [trade(WALLET_A, "BUY", 0), trade(WALLET_B, "BUY", 1), trade(WALLET_A, "SELL", 5)],
  };

  const httpClient: AddressCodeClient = {
    async getCode({ address }) {
      if (address.toLowerCase() === WALLET_CONTRACT) return "0x608060405234801561001057600080fd5b50";
      if (address.toLowerCase() === WALLET_EIP7702) return EIP7702_CODE;
      return "0x";
    },
  };

  return {
    discoveryRepo: fakeDiscoveryRepo([performingToken]),
    walletsRepo: memWalletsRepo(),
    watchlistCache: fakeWatchlistCache(),
    httpClient,
    logger: fakeLogger(),
    config: { minSnapshotsPerToken: 5, minTradesPerToken: 1, earlyBuyerWindowMinutes: 30, earlyBuyerTopN: 20 },
    now: () => new Date(2026, 0, 10),
    ...overrides,
  };
}

describe("createWalletDiscoveryJob", () => {
  it("adds real early buyers of a performing token as disabled candidates", async () => {
    const deps = baseDeps();
    const job = createWalletDiscoveryJob(deps);
    const result = await job.runOnce();

    expect(result.candidatesAdded).toBe(2);
    const stored = await deps.walletsRepo.list();
    expect(stored.map((w) => w.address).sort()).toEqual([WALLET_A, WALLET_B].sort());
    for (const w of stored) {
      expect(w.enabled).toBe(false); // never auto-activates
      expect(w.type).toBe("SMART_MONEY");
    }
  });

  it("excludes wallets already on the watchlist, in any enabled state", async () => {
    const seed: WalletEntry = {
      address: WALLET_A,
      name: "already here",
      type: "KOL",
      tier: "A",
      ownerGroup: WALLET_A,
      enabled: false,
      notes: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const deps = baseDeps({ walletsRepo: memWalletsRepo([seed]) });
    const result = await createWalletDiscoveryJob(deps).runOnce();

    expect(result.added.map((a) => a.address)).not.toContain(WALLET_A);
    expect(result.added.map((a) => a.address)).toContain(WALLET_B);
  });

  it("excludes infrastructure addresses (deployer/initializer/pool)", async () => {
    const deps = baseDeps({
      discoveryRepo: fakeDiscoveryRepo(
        [
          {
            tokenId: 1,
            address: "0x1111111111111111111111111111111111111111",
            symbol: "MOON",
            minTrades: 1,
            snapshots: snaps([1, 2, 5, 10, 20]),
            trades: [trade(WALLET_A, "BUY", 0), trade(WALLET_B, "BUY", 1)],
          },
        ],
        [WALLET_A],
      ),
    });
    const result = await createWalletDiscoveryJob(deps).runOnce();

    expect(result.added.map((a) => a.address)).not.toContain(WALLET_A);
    expect(result.added.map((a) => a.address)).toContain(WALLET_B);
  });

  it("excludes real contract addresses but KEEPS EIP-7702-delegated EOAs (regression: mineWallets.ts's naive eth_getCode check used to wrongly exclude these)", async () => {
    const deps = baseDeps({
      discoveryRepo: fakeDiscoveryRepo([
        {
          tokenId: 1,
          address: "0x1111111111111111111111111111111111111111",
          symbol: "MOON",
          minTrades: 1,
          snapshots: snaps([1, 2, 5, 10, 20]),
          trades: [trade(WALLET_CONTRACT, "BUY", 0), trade(WALLET_EIP7702, "BUY", 1)],
        },
      ]),
    });
    const result = await createWalletDiscoveryJob(deps).runOnce();

    expect(result.added.map((a) => a.address)).not.toContain(WALLET_CONTRACT);
    expect(result.added.map((a) => a.address)).toContain(WALLET_EIP7702);
  });

  it("sends a Telegram summary when candidates are added, and never throws when no client is configured", async () => {
    const sendMessage = vi.fn(async (_text: string) => ({ ok: true as const }));
    const telegramClient: TelegramClient = { sendMessage };
    const deps = baseDeps({ telegramClient });
    await createWalletDiscoveryJob(deps).runOnce();
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0]![0]).toContain("Wallet discovery");

    const depsNoTelegram = baseDeps();
    await expect(createWalletDiscoveryJob(depsNoTelegram).runOnce()).resolves.toBeDefined();
  });

  it("does nothing destructive and reports zero when no token clears the real-performance bar", async () => {
    const deps = baseDeps({
      discoveryRepo: fakeDiscoveryRepo([
        {
          tokenId: 1,
          address: "0x1111111111111111111111111111111111111111",
          symbol: "FLAT",
          minTrades: 1,
          snapshots: snaps([1, 1]), // below minSnapshotsPerToken
          trades: [trade(WALLET_A, "BUY", 0)],
        },
      ]),
    });
    const result = await createWalletDiscoveryJob(deps).runOnce();
    expect(result).toEqual({ tokensConsidered: 1, tokensRanked: 0, candidatesFound: 0, candidatesAdded: 0, added: [] });
  });
});
