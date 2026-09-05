import type { Logger } from "../logger.js";
import type { WalletEntry, WalletWatchlistRepo } from "../db/walletWatchlist.js";

export interface WatchlistCache {
  /** Looks up an enabled watchlist entry by wallet address (case-insensitive). */
  lookup(address: string): WalletEntry | undefined;
  /** Reloads the cache from the DB — call after any watchlist write. */
  refresh(): Promise<void>;
  size(): number;
  /** All currently-cached (enabled) entries — e.g. to build a `wallet = ANY(...)` SQL filter. */
  entries(): WalletEntry[];
}

/**
 * Trade detection needs a watchlist hit-check on every single trade, so it
 * must never be a per-trade DB query. This keeps an in-memory snapshot of
 * currently-enabled entries, refreshed explicitly whenever the watchlist
 * changes (API writes, bulk import) rather than on a timer — precise and
 * avoids trades briefly missing a hit against a change that already landed.
 */
export function createWatchlistCache(repo: WalletWatchlistRepo, logger: Logger): WatchlistCache {
  let byAddress = new Map<string, WalletEntry>();

  return {
    lookup(address) {
      return byAddress.get(address.toLowerCase());
    },

    async refresh() {
      const enabled = await repo.list({ enabled: true });
      byAddress = new Map(enabled.map((wallet) => [wallet.address.toLowerCase(), wallet]));
      logger.debug({ count: byAddress.size }, "watchlist cache refreshed");
    },

    size() {
      return byAddress.size;
    },

    entries() {
      return [...byAddress.values()];
    },
  };
}

/**
 * Counts distinct real-world owners rather than raw addresses — the whole
 * point of `ownerGroup` is that one person running N wallets must count as
 * 1, not N, for resonance/co-buy detection (Phase 6).
 */
export function countDistinctOwnerGroups(wallets: Pick<WalletEntry, "ownerGroup">[]): number {
  return new Set(wallets.map((wallet) => wallet.ownerGroup)).size;
}
