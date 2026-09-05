import {
  bigint,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";

// Placeholder table definitions for scaffolding only.
// Real columns will be added in a later phase.

// Tracks, per chain, the last block the watcher has fully processed.
// One row per chainId; used for restart recovery / backfill range calculation.
export const scannerState = pgTable("scanner_state", {
  chainId: integer("chain_id").primaryKey(),
  lastProcessedBlock: bigint("last_processed_block", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const launchSourceEnum = pgEnum("launch_source", ["doppler", "pons_v1"]);

export const tokens = pgTable("tokens", {
  id: serial("id").primaryKey(),
  address: varchar("address", { length: 42 }).notNull().unique(),
  symbol: varchar("symbol", { length: 64 }),
  name: varchar("name", { length: 256 }),
  launchSource: launchSourceEnum("launch_source").notNull(),
  deployer: varchar("deployer", { length: 42 }).notNull(),
  pairToken: varchar("pair_token", { length: 42 }).notNull(),
  pool: varchar("pool", { length: 42 }).notNull(),
  launchBlock: bigint("launch_block", { mode: "bigint" }).notNull(),
  launchTime: timestamp("launch_time", { withTimezone: true }).notNull(),
  launchTx: varchar("launch_tx", { length: 66 }).notNull(),
  // Doppler-only: the pool-initializer/hook contract that emits Swap /
  // ModifyLiquidity events for this token (from the Create event's
  // `initializer` field). Null for other launch sources.
  initializer: varchar("initializer", { length: 42 }),
  // Doppler-only: the Uniswap v4 PoolId for this token's bonding-curve pool,
  // i.e. keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)).
  // fee is a fixed dynamic-fee flag but tickSpacing varies per launch, so
  // this is resolved lazily from the launch's real ModifyLiquidity event
  // rather than assumed — see chain/tradeDetector.ts. Null until resolved /
  // for other launch sources.
  poolId: varchar("pool_id", { length: 66 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tradeSideEnum = pgEnum("trade_side", ["BUY", "SELL"]);

export const trades = pgTable(
  "trades",
  {
    id: serial("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tokens.id),
    wallet: varchar("wallet", { length: 42 }).notNull(),
    side: tradeSideEnum("side").notNull(),
    // Raw on-chain integer amounts (base units, e.g. wei) — not yet divided
    // by token decimals. Exceeds bigint range for many real trades, hence numeric.
    quoteAmount: numeric("quote_amount", { precision: 78, scale: 0 }).notNull(),
    tokenAmount: numeric("token_amount", { precision: 78, scale: 0 }).notNull(),
    // Null until a pricing pass fills it in — never blocks trade recording.
    usdValue: numeric("usd_value", { precision: 38, scale: 2 }),
    blockNumber: bigint("block_number", { mode: "bigint" }).notNull(),
    txHash: varchar("tx_hash", { length: 66 }).notNull(),
    logIndex: integer("log_index").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("trades_chain_tx_log_unique").on(table.chainId, table.txHash, table.logIndex)],
);

export const walletWatchlist = pgTable("wallet_watchlist", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const tokenSnapshots = pgTable("token_snapshots", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const signals = pgTable("signals", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const signalWallets = pgTable("signal_wallets", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const signalOutcomes = pgTable("signal_outcomes", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const narrativeFlags = pgTable("narrative_flags", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
