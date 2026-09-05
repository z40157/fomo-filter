import { describe, expect, it } from "vitest";
import { importWallets } from "../src/wallets/importWallets.js";
import type { NewWalletEntry, WalletEntry, WalletWatchlistRepo } from "../src/db/walletWatchlist.js";

function fakeRepo(): WalletWatchlistRepo & { rows: Map<string, WalletEntry> } {
  const rows = new Map<string, WalletEntry>();
  return {
    rows,
    list: async () => [...rows.values()],
    create: async () => null,
    update: async () => null,
    remove: async () => false,
    async upsert(entry: NewWalletEntry) {
      const address = entry.address.toLowerCase();
      const inserted = !rows.has(address);
      rows.set(address, {
        address,
        name: entry.name,
        type: entry.type,
        tier: entry.tier,
        ownerGroup: entry.ownerGroup,
        enabled: entry.enabled ?? true,
        notes: entry.notes ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      return { address, inserted };
    },
    countEnabled: async () => [...rows.values()].filter((w) => w.enabled).length,
  };
}

const VALID_ENTRY: NewWalletEntry = {
  address: "0x1234567890123456789012345678901234567890",
  name: "KOL_test",
  type: "KOL",
  tier: "A",
  ownerGroup: "test-owner",
};

describe("importWallets", () => {
  it("inserts new addresses and updates existing ones (upsert), lowercasing addresses", async () => {
    const repo = fakeRepo();

    const first = await importWallets(
      [{ ...VALID_ENTRY, address: "0xABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD" }],
      repo,
    );
    expect(first).toEqual({ inserted: 1, updated: 0, skipped: [] });
    expect(repo.rows.has("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")).toBe(true);

    const second = await importWallets(
      [{ ...VALID_ENTRY, address: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", tier: "C" }],
      repo,
    );
    expect(second).toEqual({ inserted: 0, updated: 1, skipped: [] });
    expect(repo.rows.get("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd")).toMatchObject({ tier: "C" });
    expect(repo.rows.size).toBe(1);
  });

  it("handles a mixed batch of new and existing addresses in one call", async () => {
    const repo = fakeRepo();
    await repo.upsert(VALID_ENTRY);

    const result = await importWallets(
      [
        { ...VALID_ENTRY, name: "KOL_test_renamed" },
        { ...VALID_ENTRY, address: "0x9999999999999999999999999999999999999999", name: "New_KOL" },
      ],
      repo,
    );

    expect(result).toEqual({ inserted: 1, updated: 1, skipped: [] });
    expect(repo.rows.size).toBe(2);
  });

  it("skips invalid entries without throwing, and reports why", async () => {
    const repo = fakeRepo();

    const result = await importWallets(
      [VALID_ENTRY, { ...VALID_ENTRY, address: "0x123", type: "NOT_A_TYPE" }],
      repo,
    );

    expect(result.inserted).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]?.index).toBe(1);
    expect(result.skipped[0]?.error).toMatch(/address|type/);
  });
});
