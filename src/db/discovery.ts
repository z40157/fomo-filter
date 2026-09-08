import { and, asc, count, eq, gte, isNotNull } from "drizzle-orm";
import type { Database } from "./client.js";
import { tokenSnapshots, tokens, trades } from "./schema.js";

export interface DiscoveryCandidateToken {
  tokenId: number;
  address: string;
  symbol: string | null;
}

export interface DiscoveryTradeRow {
  wallet: string;
  side: "BUY" | "SELL";
  timestamp: Date;
}

export interface DiscoverySnapshotRow {
  price: number;
  snapshotAt: Date;
}

export interface DiscoveryRepo {
  /** Tokens launched at/after `since` with at least `minTrades` recorded trades. */
  listCandidateTokens(since: Date, minTrades: number): Promise<DiscoveryCandidateToken[]>;
  /** Ascending by snapshotAt, price-known snapshots only. */
  listTokenSnapshotPrices(tokenId: number): Promise<DiscoverySnapshotRow[]>;
  /** Ascending by (blockNumber, logIndex) — the order trades actually happened on-chain. */
  listTradesForToken(tokenId: number): Promise<DiscoveryTradeRow[]>;
  /** Every deployer/initializer/pool address ever recorded — infrastructure, never a real trader. */
  listInfrastructureAddresses(): Promise<Set<string>>;
}

export function createDiscoveryRepo(db: Database): DiscoveryRepo {
  return {
    async listCandidateTokens(since, minTrades) {
      const rows = await db
        .select({ tokenId: trades.tokenId, address: tokens.address, symbol: tokens.symbol, tradeCount: count(trades.id) })
        .from(trades)
        .innerJoin(tokens, eq(trades.tokenId, tokens.id))
        .where(gte(tokens.launchTime, since))
        .groupBy(trades.tokenId, tokens.address, tokens.symbol)
        .having(gte(count(trades.id), minTrades));
      return rows.map((r) => ({ tokenId: r.tokenId, address: r.address, symbol: r.symbol }));
    },

    async listTokenSnapshotPrices(tokenId) {
      const rows = await db
        .select({ price: tokenSnapshots.price, snapshotAt: tokenSnapshots.snapshotAt })
        .from(tokenSnapshots)
        .where(and(eq(tokenSnapshots.tokenId, tokenId), isNotNull(tokenSnapshots.price)))
        .orderBy(asc(tokenSnapshots.snapshotAt));
      return rows.map((r) => ({ price: Number(r.price), snapshotAt: r.snapshotAt }));
    },

    async listTradesForToken(tokenId) {
      const rows = await db
        .select({ wallet: trades.wallet, side: trades.side, timestamp: trades.timestamp })
        .from(trades)
        .where(eq(trades.tokenId, tokenId))
        .orderBy(asc(trades.blockNumber), asc(trades.logIndex));
      return rows;
    },

    async listInfrastructureAddresses() {
      const rows = await db.select({ deployer: tokens.deployer, initializer: tokens.initializer, pool: tokens.pool }).from(tokens);
      const addresses = new Set<string>();
      for (const row of rows) {
        addresses.add(row.deployer.toLowerCase());
        if (row.initializer) addresses.add(row.initializer.toLowerCase());
        addresses.add(row.pool.toLowerCase());
      }
      return addresses;
    },
  };
}
