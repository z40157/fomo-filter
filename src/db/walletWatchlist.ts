import { and, count, eq } from "drizzle-orm";
import type { Database } from "./client.js";
import { walletWatchlist } from "./schema.js";

export type WalletType = "KOL" | "FOMO_TRADER" | "SMART_MONEY";
export type WalletTier = "A" | "B" | "C";

export interface WalletEntry {
  address: string;
  name: string;
  type: WalletType;
  tier: WalletTier;
  ownerGroup: string;
  enabled: boolean;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewWalletEntry {
  address: string;
  name: string;
  type: WalletType;
  tier: WalletTier;
  ownerGroup: string;
  enabled?: boolean;
  notes?: string | null;
}

export interface WalletPatch {
  name?: string;
  type?: WalletType;
  tier?: WalletTier;
  ownerGroup?: string;
  enabled?: boolean;
  notes?: string | null;
}

export interface WalletFilter {
  type?: WalletType;
  tier?: WalletTier;
  enabled?: boolean;
}

export interface WalletWatchlistRepo {
  list(filter?: WalletFilter): Promise<WalletEntry[]>;
  /** Returns null if the (lowercased) address already exists. */
  create(entry: NewWalletEntry): Promise<WalletEntry | null>;
  /** Returns null if no row exists for the (lowercased) address. */
  update(address: string, patch: WalletPatch): Promise<WalletEntry | null>;
  remove(address: string): Promise<boolean>;
  /** Insert-or-update by (lowercased) address, for bulk import. */
  upsert(entry: NewWalletEntry): Promise<{ address: string; inserted: boolean }>;
  countEnabled(): Promise<number>;
}

export function createWalletWatchlistRepo(db: Database): WalletWatchlistRepo {
  return {
    async list(filter) {
      const conditions = [];
      if (filter?.type !== undefined) conditions.push(eq(walletWatchlist.type, filter.type));
      if (filter?.tier !== undefined) conditions.push(eq(walletWatchlist.tier, filter.tier));
      if (filter?.enabled !== undefined) conditions.push(eq(walletWatchlist.enabled, filter.enabled));

      if (conditions.length === 0) {
        return db.select().from(walletWatchlist);
      }
      return db
        .select()
        .from(walletWatchlist)
        .where(and(...conditions));
    },

    async create(entry) {
      const address = entry.address.toLowerCase();
      const rows = await db
        .insert(walletWatchlist)
        .values({ ...entry, address, enabled: entry.enabled ?? true, notes: entry.notes ?? null })
        .onConflictDoNothing({ target: walletWatchlist.address })
        .returning();
      return rows[0] ?? null;
    },

    async update(address, patch) {
      const lower = address.toLowerCase();
      const rows = await db
        .update(walletWatchlist)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(walletWatchlist.address, lower))
        .returning();
      return rows[0] ?? null;
    },

    async remove(address) {
      const lower = address.toLowerCase();
      const rows = await db
        .delete(walletWatchlist)
        .where(eq(walletWatchlist.address, lower))
        .returning({ address: walletWatchlist.address });
      return rows.length > 0;
    },

    async upsert(entry) {
      const address = entry.address.toLowerCase();
      const existing = await db
        .select({ address: walletWatchlist.address })
        .from(walletWatchlist)
        .where(eq(walletWatchlist.address, address))
        .limit(1);

      if (existing.length > 0) {
        await db
          .update(walletWatchlist)
          .set({
            name: entry.name,
            type: entry.type,
            tier: entry.tier,
            ownerGroup: entry.ownerGroup,
            enabled: entry.enabled ?? true,
            notes: entry.notes ?? null,
            updatedAt: new Date(),
          })
          .where(eq(walletWatchlist.address, address));
        return { address, inserted: false };
      }

      await db
        .insert(walletWatchlist)
        .values({ ...entry, address, enabled: entry.enabled ?? true, notes: entry.notes ?? null });
      return { address, inserted: true };
    },

    async countEnabled() {
      const rows = await db.select({ value: count() }).from(walletWatchlist).where(eq(walletWatchlist.enabled, true));
      return rows[0]?.value ?? 0;
    },
  };
}
