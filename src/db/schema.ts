import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
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
export const riskLevelEnum = pgEnum("risk_level", ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]);
export const confidenceLevelEnum = pgEnum("confidence_level", ["LOW", "MEDIUM", "HIGH"]);

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
    // Phase 7: all rule-based, no ML — see signals/scoring.ts and
    // signals/risk.ts. Every number here must be reconstructable from
    // score_breakdown/risk_breakdown; nothing is a black box.
    importanceScore: numeric("importance_score", { precision: 4, scale: 2 }),
    // Structured per-dimension breakdown (score + reasons) — see
    // signals/scoring.ts's ScoreBreakdown shape.
    scoreBreakdown: jsonb("score_breakdown"),
    riskLevel: riskLevelEnum("risk_level"),
    // Per-factor breakdown (level + reason) — see signals/risk.ts's
    // RiskBreakdown shape. UNKNOWN factors are recorded here too, even
    // when the overall riskLevel isn't UNKNOWN.
    riskBreakdown: jsonb("risk_breakdown"),
    confidence: confidenceLevelEnum("confidence"),
    // Human-readable reasons for the confidence level — independent of
    // importanceScore and riskLevel (a high-importance signal can be
    // low-confidence at the same time; that's not a bug).
    confidenceReasons: jsonb("confidence_reasons"),
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

export const alertChannelEnum = pgEnum("alert_channel", ["email", "telegram"]);
export const deliveryStatusEnum = pgEnum("delivery_status", ["sent", "failed"]);

// One row per delivery attempt (not per signal) — a signal that fires both
// an email and a Telegram message gets two rows. Dedup/cooldown decisions
// (alerts/alertLogic.ts) are made per (tokenId, channel) by reading the
// most recent "sent" row here, joined back to `signals` for the
// ownerGroup/Tier-A counts at that time.
export const alerts = pgTable(
  "alerts",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id")
      .notNull()
      .references(() => signals.id),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tokens.id),
    channel: alertChannelEnum("channel").notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).notNull(),
    importanceAtSend: numeric("importance_at_send", { precision: 4, scale: 2 }).notNull(),
    riskAtSend: riskLevelEnum("risk_at_send"),
    confidenceAtSend: confidenceLevelEnum("confidence_at_send"),
    // Which dedup/cooldown rule allowed this send — see alerts/alertLogic.ts's
    // AlertTriggerReason for the fixed set of values.
    triggerReason: varchar("trigger_reason", { length: 32 }).notNull(),
    deliveryStatus: deliveryStatusEnum("delivery_status").notNull(),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("alerts_token_id_channel_sent_at_idx").on(table.tokenId, table.channel, table.sentAt)],
);

// Phase 9 — Outcome Tracker. The system's only mechanism for ever
// answering "was a 7-point signal actually any good?". One row per tracked
// signal (importanceScore >= 6.0 — note: BELOW the 7.0 alert threshold, so
// "we alerted vs we didn't" stays analysable), holding the baseline
// captured at signal time plus discrete-sample summary metrics that
// `signal_outcome_points` rows roll up into.
//
// **Data honesty rule for this whole feature: record null, never guess.**
// If DexScreener had no data at signal time, the row is still created but
// `baseline_available = false` so analysis can exclude it cleanly.
export const signalOutcomes = pgTable(
  "signal_outcomes",
  {
    id: serial("id").primaryKey(),
    signalId: integer("signal_id")
      .notNull()
      .references(() => signals.id),
    tokenId: integer("token_id")
      .notNull()
      .references(() => tokens.id),
    baselineAt: timestamp("baseline_at", { withTimezone: true }).notNull(),
    // Captured from a fresh DexScreener fetch at signal-creation time. Null
    // when DexScreener had nothing for this token yet.
    baselinePrice: numeric("baseline_price", { precision: 38, scale: 18 }),
    baselineMarketCap: numeric("baseline_market_cap", { precision: 38, scale: 2 }),
    baselineLiquidity: numeric("baseline_liquidity", { precision: 38, scale: 2 }),
    // false iff baselinePrice is null — the flag analysis filters on so a
    // no-baseline row never pollutes a returnPct statistic.
    baselineAvailable: boolean("baseline_available").notNull(),
    // Snapshot of the signal's rating at trigger time — copied here so an
    // outcome analysis doesn't have to join back to a `signals` row that
    // may have been scored under a since-changed ruleset.
    importanceScore: numeric("importance_score", { precision: 4, scale: 2 }).notNull(),
    riskLevel: riskLevelEnum("risk_level"),
    confidence: confidenceLevelEnum("confidence"),
    scoreBreakdown: jsonb("score_breakdown").notNull(),
    // signals/scoring.ts's SCORING_RULE_VERSION at capture time. Bumped
    // whenever the scoring rules change; lets analysis segment by ruleset.
    scoringRuleVersion: integer("scoring_rule_version").notNull(),
    // Rolled up from signal_outcome_points as they are recorded. All
    // derived from the 5 DISCRETE sample points only — NOT a continuous
    // price feed, so the true peak/trough between two samples is never
    // observed. Null until at least one point with usable data exists.
    maxPrice: numeric("max_price", { precision: 38, scale: 18 }),
    // Highest returnPct (%) seen at any sampled point, vs baseline.
    maxReturnPct: numeric("max_return_pct", { precision: 16, scale: 4 }),
    minPrice: numeric("min_price", { precision: 38, scale: 18 }),
    // Worst peak-to-trough drop (%) across sampled points, measured from
    // the running max of the points seen so far (order-aware). Negative.
    maxDrawdownPct: numeric("max_drawdown_pct", { precision: 16, scale: 4 }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("signal_outcomes_signal_id_unique").on(table.signalId),
    index("signal_outcomes_importance_idx").on(table.importanceScore),
    index("signal_outcomes_risk_confidence_idx").on(table.riskLevel, table.confidence),
    index("signal_outcomes_baseline_available_idx").on(table.baselineAvailable),
  ],
);

// One row per (signal outcome, tracking offset). Five per outcome:
// +5m / +15m / +1h / +6h / +24h. Created unrecorded at signal time; a
// restart-tolerant sweeper fills each in once `due_at` passes by reading
// the still-pending rows straight from this table (never an in-memory
// setTimeout — those don't survive a restart and don't scale).
export const signalOutcomePoints = pgTable(
  "signal_outcome_points",
  {
    id: serial("id").primaryKey(),
    signalOutcomeId: integer("signal_outcome_id")
      .notNull()
      .references(() => signalOutcomes.id),
    // "5m" | "15m" | "1h" | "6h" | "24h" — a stable label, not a duration,
    // so shrinking the offsets for a test doesn't invalidate old rows.
    offsetLabel: varchar("offset_label", { length: 8 }).notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    // Null until the sweeper records this point.
    recordedAt: timestamp("recorded_at", { withTimezone: true }),
    // Whether DexScreener actually returned data at record time. Null until recorded.
    dataAvailable: boolean("data_available"),
    price: numeric("price", { precision: 38, scale: 18 }),
    marketCap: numeric("market_cap", { precision: 38, scale: 2 }),
    liquidity: numeric("liquidity", { precision: 38, scale: 2 }),
    volume5m: numeric("volume_5m", { precision: 38, scale: 2 }),
    // (%) vs the outcome's baseline. Null if EITHER side is missing — never 0.
    returnPct: numeric("return_pct", { precision: 16, scale: 4 }),
    marketCapChangePct: numeric("market_cap_change_pct", { precision: 16, scale: 4 }),
    // recordedAt - dueAt, in seconds. Recorded truthfully even when a
    // restart meant a +5m point was actually taken at +8m.
    actualDelaySeconds: integer("actual_delay_seconds"),
    // actualDelaySeconds over this offset's tolerance (see outcomeTrackerLogic.ts).
    delayed: boolean("delayed"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("signal_outcome_points_outcome_offset_unique").on(table.signalOutcomeId, table.offsetLabel),
    // The sweeper's hot query: still-pending points whose due_at has passed.
    index("signal_outcome_points_pending_idx").on(table.recordedAt, table.dueAt),
  ],
);

// Manually-curated narrative boost per token — V1 does no AI narrative
// analysis (see signals/scoring.ts's Dimension E). A human sets `boost`
// (0-1) after judging a token's narrative relevance; the scorer only ever
// reads the latest row for a token, never infers one itself.
export const narrativeFlags = pgTable("narrative_flags", {
  id: serial("id").primaryKey(),
  tokenId: integer("token_id")
    .notNull()
    .references(() => tokens.id),
  boost: numeric("boost", { precision: 3, scale: 2 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
