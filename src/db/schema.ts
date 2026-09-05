import {
  bigint,
  boolean,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
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

export const walletTypeEnum = pgEnum("wallet_type", ["KOL", "FOMO_TRADER", "SMART_MONEY"]);
export const walletTierEnum = pgEnum("wallet_tier", ["A", "B", "C"]);

// V1 is entirely manually curated — no auto-classification of who's a KOL.
// This table only stores, dedups (address is the PK, always lowercased),
// and gets compared against during trade parsing.
export const walletWatchlist = pgTable("wallet_watchlist", {
  address: varchar("address", { length: 42 }).primaryKey(),
  name: varchar("name", { length: 256 }).notNull(),
  type: walletTypeEnum("type").notNull(),
  tier: walletTierEnum("tier").notNull(),
  // Groups multiple addresses controlled by the same real-world entity, so
  // later resonance/co-buy detection counts distinct owners, not addresses
  // — one person running 5 wallets must never look like 5 independent KOLs.
  ownerGroup: varchar("owner_group", { length: 128 }).notNull(),
  enabled: boolean("enabled").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

// Periodic DexScreener market-data snapshots per token. Grows without
// bound in V1 (no retention/cleanup implemented yet) — see PROGRESS.md for
// the estimated growth rate and future cleanup options.
export const tokenSnapshots = pgTable(
  "token_snapshots",
  {
    id: serial("id").primaryKey(),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tokens.id),
    // USD price, up to 18 decimal places — meme-coin prices routinely go
    // well below $0.0001.
    price: numeric("price", { precision: 38, scale: 18 }),
    marketCap: numeric("market_cap", { precision: 38, scale: 2 }),
    liquidity: numeric("liquidity", { precision: 38, scale: 2 }),
    volume5m: numeric("volume_5m", { precision: 38, scale: 2 }),
    volume1h: numeric("volume_1h", { precision: 38, scale: 2 }),
    buys5m: integer("buys_5m"),
    sells5m: integer("sells_5m"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("token_snapshots_token_id_snapshot_at_idx").on(table.tokenId, table.snapshotAt)],
);

export const signalTriggerConditionEnum = pgEnum("signal_trigger_condition", ["A", "B", "C"]);

// A resonance signal is a TRIGGER, not a buy recommendation — see
// signals/resonanceLogic.ts. This table only records that the detector
// fired and why; scoring (Phase 7) and alerting (Phase 8) are separate.
export const signals = pgTable(
  "signals",
  {
    id: serial("id").primaryKey(),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tokens.id),
    triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull(),
    // Can hold more than one condition — they're independent checks and a
    // window can satisfy several at once.
    triggerConditions: signalTriggerConditionEnum("trigger_conditions").array().notNull(),
    distinctOwnerGroups: integer("distinct_owner_groups").notNull(),
    tierACount: integer("tier_a_count").notNull(),
    hasRepeatAccumulation: boolean("has_repeat_accumulation").notNull(),
    // The window size THIS signal used — config can change later, so this
    // is what lets you re-interpret an old signal correctly.
    windowMinutes: integer("window_minutes").notNull(),
    // True if this signal broke through an active cooldown because the
    // window got strictly stronger (see resonanceLogic.ts).
    escalation: boolean("escalation").notNull().default(false),
    // From candidateTracker's in-memory DexScreener snapshot at trigger
    // time — null if none was available yet (e.g. a brand new token).
    marketCap: numeric("market_cap", { precision: 38, scale: 2 }),
    liquidity: numeric("liquidity", { precision: 38, scale: 2 }),
    volume5m: numeric("volume_5m", { precision: 38, scale: 2 }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("signals_token_id_triggered_at_idx").on(table.tokenId, table.triggeredAt)],
);

// One row per participating wallet for a given signal — who triggered it.
export const signalWallets = pgTable("signal_wallets", {
  id: serial("id").primaryKey(),
  signalId: integer("signal_id")
    .notNull()
    .references(() => signals.id),
  walletAddress: varchar("wallet_address", { length: 42 }).notNull(),
  walletName: varchar("wallet_name", { length: 256 }).notNull(),
  tier: walletTierEnum("tier").notNull(),
  ownerGroup: varchar("owner_group", { length: 128 }).notNull(),
  buyCount: integer("buy_count").notNull(),
  // Raw on-chain integer, same convention as trades.quote_amount — this
  // token's own quote currency, not USD (comparable across wallets within
  // one signal, since they share a token/quote currency; not across signals).
  buyAmount: numeric("buy_amount", { precision: 78, scale: 0 }).notNull(),
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
