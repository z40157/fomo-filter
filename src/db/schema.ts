import { bigint, integer, pgEnum, pgTable, serial, timestamp, varchar } from "drizzle-orm/pg-core";

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
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

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
