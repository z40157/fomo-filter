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

// V2 hot-radar tables — additive only, lives in the Shadow Postgres
// alongside a one-time read-only import of V1's tables (see
// shadowSchema.ts). Never referenced by V1's schema.ts / index.ts.

// Radar lifecycle (how long the Hot Radar keeps paying attention to a
// candidate) is a deliberately separate axis from protocol lifecycle (what
// state the launchpad/pool itself is in) — see hotradar/types.ts for the
// full state sets. A token can be EXPIRED_30M on the radar while its
// protocolState keeps updating (e.g. reaches GRADUATED) forever after.
export const radarStateEnum = pgEnum("radar_state", [
  "DISCOVERED",
  "EARLY_OBSERVATION",
  "HOT",
  "REJECTED",
  "EXPIRED_30M",
]);

export const protocolStateEnum = pgEnum("protocol_state", [
  "UNKNOWN",
  "CURVE_ACTIVE",
  "NEAR_GRADUATION",
  "GRADUATED",
  "POOL_PENDING",
  "POOL_ACTIVE",
  "SURVIVING",
  "DECAYING",
]);

export const gateStatusEnum = pgEnum("gate_status", ["PASS", "REJECT", "UNKNOWN_REVIEW"]);
export const chainKeyEnum = pgEnum("chain_key", ["robinhood", "solana", "bsc", "bch"]);

// One row per token the V2 radar has ever picked up, from DISCOVERED
// through EXPIRED_30M and beyond (protocolState keeps updating after
// expiry — see radarStateEnum comment). `latest*` columns are a fast-read
// cache of the most recent evaluation; the full history is in
// candidate_score_history.
export const hotCandidates = pgTable(
  "hot_candidates",
  {
    id: serial("id").primaryKey(),
    chain: chainKeyEnum("chain").notNull(),
    // References V1/shadow `tokens.id` loosely (no FK across the
    // read-only-imported V1 tables — see A.1: the two DBs never sync back).
    tokenId: integer("token_id").notNull(),
    tokenAddress: varchar("token_address", { length: 64 }).notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull(),
    // t0 — see hotradar adapter contract (A.5). EVM chains also keep the
    // launch block/hash for reorg detection (below); non-EVM chains may
    // leave those null and rely on launchedAt alone.
    launchedAt: timestamp("launched_at", { withTimezone: true }).notNull(),
    launchBlockNumber: bigint("launch_block_number", { mode: "bigint" }),
    launchBlockHash: varchar("launch_block_hash", { length: 66 }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    radarState: radarStateEnum("radar_state").notNull().default("DISCOVERED"),
    protocolState: protocolStateEnum("protocol_state").notNull().default("UNKNOWN"),
    gateStatus: gateStatusEnum("gate_status").notNull().default("UNKNOWN_REVIEW"),
    gateReasons: jsonb("gate_reasons").notNull().default([]),
    latestBreakoutScore: numeric("latest_breakout_score", { precision: 4, scale: 2 }),
    latestOrganicScore: numeric("latest_organic_score", { precision: 4, scale: 2 }),
    latestKolScore: numeric("latest_kol_score", { precision: 4, scale: 2 }),
    latestRisk: varchar("latest_risk", { length: 16 }),
    latestConfidence: varchar("latest_confidence", { length: 16 }),
    lastEvaluatedAt: timestamp("last_evaluated_at", { withTimezone: true }),
    // Reorg guard (A.5): if the launch block is invalidated by a reorg,
    // this candidate can never again be treated as a real launch.
    invalidated: boolean("invalidated").notNull().default(false),
    invalidatedReason: text("invalidated_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("hot_candidates_chain_token_address_unique").on(table.chain, table.tokenAddress),
    index("hot_candidates_radar_state_idx").on(table.radarState),
    index("hot_candidates_expires_at_idx").on(table.expiresAt),
  ],
);

// Phase A.16 — every score evaluation, not just the latest. Lets later
// analysis ask "what did this candidate score at +3m / +5m / +10m / +20m /
// +30m" instead of only ever seeing the final number.
export const candidateScoreHistory = pgTable(
  "candidate_score_history",
  {
    id: serial("id").primaryKey(),
    hotCandidateId: integer("hot_candidate_id")
      .notNull()
      .references(() => hotCandidates.id),
    scoreAt: timestamp("score_at", { withTimezone: true }).notNull(),
    ageMs: bigint("age_ms", { mode: "number" }).notNull(),
    breakoutScore: numeric("breakout_score", { precision: 4, scale: 2 }).notNull(),
    organicScore: numeric("organic_score", { precision: 4, scale: 2 }).notNull(),
    kolScore: numeric("kol_score", { precision: 4, scale: 2 }).notNull(),
    risk: varchar("risk", { length: 16 }).notNull(),
    confidence: varchar("confidence", { length: 16 }).notNull(),
    breakdown: jsonb("breakdown").notNull(),
    ruleVersion: integer("rule_version").notNull(),
    gateStatus: gateStatusEnum("gate_status").notNull(),
    // Snapshot of hot_candidates.gate_reasons AT this evaluation (spec §2.2)
    // — the fast-read column on hot_candidates only ever holds the latest
    // value, so history needs its own copy to answer "what was UNKNOWN at
    // +5m" after gate_reasons has since changed.
    gateReasons: jsonb("gate_reasons").notNull().default([]),
    radarState: radarStateEnum("radar_state").notNull(),
    protocolState: protocolStateEnum("protocol_state").notNull(),
    // B3 §2.2/§5.3 — actual alert tier (after confidence-cap + risk-override)
    // vs. the uncapped tier from breakoutScore alone. tierUncapped is
    // persisted/counted only, NEVER sent as an alert (see hotradar/manager.ts).
    tier: varchar("tier", { length: 16 }).notNull(),
    tierUncapped: varchar("tier_uncapped", { length: 16 }).notNull(),
    // Raw feature values (volume1m, uniqueBuyers3m, holderCount, ...) — NOT
    // normalized scores, so a future re-weighting can be replayed against
    // real history (spec §2.2: "归一化规则会变，原始值不会").
    features: jsonb("features").notNull(),
    // Per-dimension OK/UNKNOWN/ERROR+reason for the 4 unresolved inputs plus
    // market data completeness (hotradar/dataStatus.ts) — this run's core
    // diagnostic output (spec §5.2).
    dataStatus: jsonb("data_status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("candidate_score_history_hot_candidate_id_score_at_idx").on(table.hotCandidateId, table.scoreAt)],
);

// Q4/B2.7 — only what can actually be computed reliably today
// (launchesTotal/launches24h/lastLaunchAt from our own launch detection,
// graduated/survived/earlySell counts once B2 wires them up). Anything
// not yet computable stays null — see B2.7: "不要猜 rugLikeCount 如果没有证据".
export const creatorProfiles = pgTable(
  "creator_profiles",
  {
    id: serial("id").primaryKey(),
    chain: chainKeyEnum("chain").notNull(),
    creator: varchar("creator", { length: 64 }).notNull(),
    launchesTotal: integer("launches_total").notNull().default(0),
    launches24h: integer("launches_24h").notNull().default(0),
    graduatedCount: integer("graduated_count"),
    survived1h: integer("survived_1h"),
    survived24h: integer("survived_24h"),
    survived7d: integer("survived_7d"),
    earlySellCount: integer("early_sell_count"),
    rugLikeCount: integer("rug_like_count"),
    medianPeakMc: numeric("median_peak_mc", { precision: 38, scale: 2 }),
    lastLaunchAt: timestamp("last_launch_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("creator_profiles_chain_creator_unique").on(table.chain, table.creator)],
);

// A.16-adjacent audit trail of every radarState/protocolState transition —
// not required by any single spec line item verbatim, but B6 explicitly
// tests "RadarState / ProtocolState 独立" and score-history-driven analysis
// needs to know exactly when a transition happened, not just infer it from
// score_history gaps.
export const tokenLifecycleEvents = pgTable(
  "token_lifecycle_events",
  {
    id: serial("id").primaryKey(),
    hotCandidateId: integer("hot_candidate_id")
      .notNull()
      .references(() => hotCandidates.id),
    eventAt: timestamp("event_at", { withTimezone: true }).notNull(),
    // B3 §2.1 — age at the moment of transition, so a report can flag
    // "oldest HOT candidate age" style bugs without re-joining hot_candidates.
    ageMs: bigint("age_ms", { mode: "number" }).notNull(),
    // "radarState" | "protocolState" | "gateStatus" | "invalidated" | "alert"
    field: varchar("field", { length: 32 }).notNull(),
    fromValue: varchar("from_value", { length: 32 }),
    toValue: varchar("to_value", { length: 32 }).notNull(),
    reason: text("reason"),
    // B3 §2.1 — structured detail (e.g. alert tier's score/risk/confidence
    // at fire time). gateReasons duplicated here (not just reason text) for
    // REJECT/UNKNOWN_REVIEW transitions per spec §2.1.
    reasonDetail: jsonb("reason_detail"),
    gateReasons: jsonb("gate_reasons"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("token_lifecycle_events_hot_candidate_id_event_at_idx").on(table.hotCandidateId, table.eventAt)],
);

// B3 §4 — Outcome Tracking sample schedule, persisted so a restart doesn't
// lose pending sample points (spec §4.2: "采样调度必须能在restart后恢复").
// One row per (candidate, offset) — created all 7 at once the moment a
// candidate first crosses into HOT/PASS/ALERT (spec §4's trigger set).
export const outcomeOffsetEnum = pgEnum("outcome_offset", ["5m", "15m", "30m", "1h", "2h", "6h", "24h"]);
export const outcomePointStatusEnum = pgEnum("outcome_point_status", ["PENDING", "DONE", "SKIPPED"]);

export const candidateOutcomePoints = pgTable(
  "candidate_outcome_points",
  {
    id: serial("id").primaryKey(),
    hotCandidateId: integer("hot_candidate_id")
      .notNull()
      .references(() => hotCandidates.id),
    offsetLabel: outcomeOffsetEnum("offset_label").notNull(),
    baselineAt: timestamp("baseline_at", { withTimezone: true }).notNull(),
    baselinePrice: numeric("baseline_price", { precision: 38, scale: 18 }),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    status: outcomePointStatusEnum("status").notNull().default("PENDING"),
    sampledAt: timestamp("sampled_at", { withTimezone: true }),
    price: numeric("price", { precision: 38, scale: 18 }),
    returnPct: numeric("return_pct", { precision: 12, scale: 4 }),
    maxReturnPct: numeric("max_return_pct", { precision: 12, scale: 4 }),
    maxDrawdownPct: numeric("max_drawdown_pct", { precision: 12, scale: 4 }),
    liquidityUsd: numeric("liquidity_usd", { precision: 38, scale: 2 }),
    volumeUsd: numeric("volume_usd", { precision: 38, scale: 2 }),
    holders: integer("holders"),
    // "hot_pipeline" (5m/15m/30m, spec §4.1 — no extra RPC/API call) |
    // "chain_adapter_liquidity_only" (1h/2h/6h/24h cold sample, spec §4.2)
    dataSource: varchar("data_source", { length: 32 }),
    dataStatus: varchar("data_status", { length: 16 }).notNull().default("UNKNOWN"),
    dataStatusReason: text("data_status_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("candidate_outcome_points_hot_candidate_id_offset_label_unique").on(table.hotCandidateId, table.offsetLabel),
    index("candidate_outcome_points_status_scheduled_at_idx").on(table.status, table.scheduledAt),
  ],
);

// A.17 — the launchpad/protocol contract addresses + event names each
// ChainAdapter is actually watching, persisted so a restart/redeploy can
// log/verify what it's subscribed to without re-deriving it from env vars
// scattered across config. One row per (chain, source, contract role).
export const chainSources = pgTable(
  "chain_sources",
  {
    id: serial("id").primaryKey(),
    chain: chainKeyEnum("chain").notNull(),
    source: varchar("source", { length: 32 }).notNull(),
    // "factory" | "airlock" | "initializer" | "pool" | "hook"
    role: varchar("role", { length: 32 }).notNull(),
    address: varchar("address", { length: 64 }).notNull(),
    eventName: varchar("event_name", { length: 128 }),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("chain_sources_chain_source_role_address_unique").on(table.chain, table.source, table.role, table.address)],
);

// B1.9/B1.10 — periodic snapshots of the in-memory RPC counter (see
// chain/rpcMetrics.ts), so 24h usage/budget history survives a restart
// instead of resetting with the process. Written on a timer, not per-call
// (per-call would defeat the point of reducing RPC/DB load).
export const rpcMetricsSnapshots = pgTable(
  "rpc_metrics",
  {
    id: serial("id").primaryKey(),
    chain: chainKeyEnum("chain").notNull(),
    // B3 §4.2 — "hot" (launch/trade/holder feeds) vs "outcome" (cold
    // 1h/2h/6h/24h sampling) counted separately so one never masks the
    // other's growth. Defaults to "hot" — the only category that existed
    // before B3.
    category: varchar("category", { length: 16 }).notNull().default("hot"),
    snapshotAt: timestamp("snapshot_at", { withTimezone: true }).notNull(),
    rpcRequests1m: integer("rpc_requests_1m").notNull(),
    ethGetLogs1m: integer("eth_get_logs_1m").notNull(),
    ethCall1m: integer("eth_call_1m").notNull(),
    ethGetTransaction1m: integer("eth_get_transaction_1m").notNull(),
    ethGetReceipt1m: integer("eth_get_receipt_1m").notNull(),
    ethGetBlock1m: integer("eth_get_block_1m").notNull(),
    wsEvents1m: integer("ws_events_1m").notNull(),
    estimatedCredits1m: numeric("estimated_credits_1m", { precision: 20, scale: 4 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("rpc_metrics_chain_snapshot_at_idx").on(table.chain, table.snapshotAt)],
);

// B2.5/A.10 trader-concentration aggregates, rolled up per candidate per
// evaluation — top3/top5 trader share needs a running per-wallet volume
// total per token, which is too expensive to recompute from raw trades on
// every scoring pass once a token has thousands of trades. This table is
// the incrementally-maintained aggregate the scorer reads instead.
export const candidateTraderAggregates = pgTable(
  "candidate_trader_aggregates",
  {
    id: serial("id").primaryKey(),
    hotCandidateId: integer("hot_candidate_id")
      .notNull()
      .references(() => hotCandidates.id),
    wallet: varchar("wallet", { length: 64 }).notNull(),
    buyVolumeUsd: numeric("buy_volume_usd", { precision: 38, scale: 2 }).notNull().default("0"),
    sellVolumeUsd: numeric("sell_volume_usd", { precision: 38, scale: 2 }).notNull().default("0"),
    buyCount: integer("buy_count").notNull().default(0),
    sellCount: integer("sell_count").notNull().default(0),
    firstTradeAt: timestamp("first_trade_at", { withTimezone: true }).notNull(),
    lastTradeAt: timestamp("last_trade_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("candidate_trader_aggregates_hot_candidate_wallet_unique").on(table.hotCandidateId, table.wallet),
    index("candidate_trader_aggregates_hot_candidate_id_idx").on(table.hotCandidateId),
  ],
);
