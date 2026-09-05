// Pure aggregation math over already-fetched trade rows — kept separate
// from the DB queries in candidateTracker.ts so it's directly unit-testable.

import { countDistinctOwnerGroups } from "../watchlist/watchlistCache.js";
import type { WalletEntry } from "../db/walletWatchlist.js";

export interface WatchlistTradeRow {
  wallet: string;
  side: "BUY" | "SELL";
  /** From trades.usd_value — still null for most trades until the enrichment job backfills it. */
  usdValue: number | null;
}

export interface WatchedAggregates {
  watchedWalletBuyCount: number;
  /** Distinct ownerGroups among watchlist wallets that BOUGHT — the resonance-relevant count, not raw address count. */
  independentOwnerCount: number;
  /** Sum of usd_value for watchlist BUYs — undercounts until enrichment has backfilled usd_value for the relevant trades. */
  aggregateWatchedBuyUsd: number;
  /** Same caveat as aggregateWatchedBuyUsd, for SELLs. */
  aggregateWatchedSellUsd: number;
}

export function computeWatchedAggregates(
  watchlistTrades: WatchlistTradeRow[],
  lookupWallet: (address: string) => WalletEntry | undefined,
): WatchedAggregates {
  let watchedWalletBuyCount = 0;
  let aggregateWatchedBuyUsd = 0;
  let aggregateWatchedSellUsd = 0;
  const buyerOwners: Pick<WalletEntry, "ownerGroup">[] = [];

  for (const trade of watchlistTrades) {
    const entry = lookupWallet(trade.wallet);
    if (!entry) continue; // defensive — caller should have already scoped rows to watchlist wallets
    if (trade.side === "BUY") {
      watchedWalletBuyCount++;
      buyerOwners.push(entry);
      if (trade.usdValue !== null) aggregateWatchedBuyUsd += trade.usdValue;
    } else if (trade.usdValue !== null) {
      aggregateWatchedSellUsd += trade.usdValue;
    }
  }

  return {
    watchedWalletBuyCount,
    independentOwnerCount: countDistinctOwnerGroups(buyerOwners),
    aggregateWatchedBuyUsd,
    aggregateWatchedSellUsd,
  };
}

/**
 * Counts wallets that bought a token 2+ times ("adding to position") —
 * deliberately over ALL buyers, not just watchlist wallets: it's a general
 * momentum signal (same "reentry" concept scripts/mineWallets.ts already
 * used), independent of whether any of them happen to be on the watchlist.
 */
export function computeRepeatBuyerCount(buyCountByWallet: Map<string, number>): number {
  let count = 0;
  for (const buyCount of buyCountByWallet.values()) {
    if (buyCount >= 2) count++;
  }
  return count;
}
