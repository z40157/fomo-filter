CREATE TYPE "public"."alert_channel" AS ENUM('email', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."confidence_level" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."launch_source" AS ENUM('doppler', 'pons_v1');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN');--> statement-breakpoint
CREATE TYPE "public"."signal_trigger_condition" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TYPE "public"."trade_side" AS ENUM('BUY', 'SELL');--> statement-breakpoint
CREATE TYPE "public"."wallet_tier" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TYPE "public"."wallet_type" AS ENUM('KOL', 'FOMO_TRADER', 'SMART_MONEY');--> statement-breakpoint
CREATE TYPE "public"."chain_key" AS ENUM('robinhood', 'solana', 'bsc', 'bch');--> statement-breakpoint
CREATE TYPE "public"."gate_status" AS ENUM('PASS', 'REJECT', 'UNKNOWN_REVIEW');--> statement-breakpoint
CREATE TYPE "public"."protocol_state" AS ENUM('UNKNOWN', 'CURVE_ACTIVE', 'NEAR_GRADUATION', 'GRADUATED', 'POOL_PENDING', 'POOL_ACTIVE', 'SURVIVING', 'DECAYING');--> statement-breakpoint
CREATE TYPE "public"."radar_state" AS ENUM('DISCOVERED', 'EARLY_OBSERVATION', 'HOT', 'REJECTED', 'EXPIRED_30M');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "alerts" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"channel" "alert_channel" NOT NULL,
	"sent_at" timestamp with time zone NOT NULL,
	"importance_at_send" numeric(4, 2) NOT NULL,
	"risk_at_send" "risk_level",
	"confidence_at_send" "confidence_level",
	"trigger_reason" varchar(32) NOT NULL,
	"delivery_status" "delivery_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "narrative_flags" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_id" integer NOT NULL,
	"boost" numeric(3, 2) NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "scanner_state" (
	"chain_id" integer PRIMARY KEY NOT NULL,
	"last_processed_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_outcome_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_outcome_id" integer NOT NULL,
	"offset_label" varchar(8) NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone,
	"data_available" boolean,
	"price" numeric(38, 18),
	"market_cap" numeric(38, 2),
	"liquidity" numeric(38, 2),
	"volume_5m" numeric(38, 2),
	"return_pct" numeric(16, 4),
	"market_cap_change_pct" numeric(16, 4),
	"actual_delay_seconds" integer,
	"delayed" boolean,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_outcome_points_outcome_offset_unique" UNIQUE("signal_outcome_id","offset_label")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_outcomes" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"baseline_at" timestamp with time zone NOT NULL,
	"baseline_price" numeric(38, 18),
	"baseline_market_cap" numeric(38, 2),
	"baseline_liquidity" numeric(38, 2),
	"baseline_available" boolean NOT NULL,
	"importance_score" numeric(4, 2) NOT NULL,
	"risk_level" "risk_level",
	"confidence" "confidence_level",
	"score_breakdown" jsonb NOT NULL,
	"scoring_rule_version" integer NOT NULL,
	"max_price" numeric(38, 18),
	"max_return_pct" numeric(16, 4),
	"min_price" numeric(38, 18),
	"max_drawdown_pct" numeric(16, 4),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signal_outcomes_signal_id_unique" UNIQUE("signal_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signal_wallets" (
	"id" serial PRIMARY KEY NOT NULL,
	"signal_id" integer NOT NULL,
	"wallet_address" varchar(42) NOT NULL,
	"wallet_name" varchar(256) NOT NULL,
	"tier" "wallet_tier" NOT NULL,
	"owner_group" varchar(128) NOT NULL,
	"buy_count" integer NOT NULL,
	"buy_amount" numeric(78, 0) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_id" integer NOT NULL,
	"triggered_at" timestamp with time zone NOT NULL,
	"trigger_conditions" "signal_trigger_condition"[] NOT NULL,
	"distinct_owner_groups" integer NOT NULL,
	"tier_a_count" integer NOT NULL,
	"has_repeat_accumulation" boolean NOT NULL,
	"window_minutes" integer NOT NULL,
	"escalation" boolean DEFAULT false NOT NULL,
	"market_cap" numeric(38, 2),
	"liquidity" numeric(38, 2),
	"volume_5m" numeric(38, 2),
	"importance_score" numeric(4, 2),
	"score_breakdown" jsonb,
	"risk_level" "risk_level",
	"risk_breakdown" jsonb,
	"confidence" "confidence_level",
	"confidence_reasons" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_snapshots" (
	"id" serial PRIMARY KEY NOT NULL,
	"token_id" integer NOT NULL,
	"price" numeric(38, 18),
	"market_cap" numeric(38, 2),
	"liquidity" numeric(38, 2),
	"volume_5m" numeric(38, 2),
	"volume_1h" numeric(38, 2),
	"buys_5m" integer,
	"sells_5m" integer,
	"snapshot_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"address" varchar(42) NOT NULL,
	"symbol" varchar(64),
	"name" varchar(256),
	"launch_source" "launch_source" NOT NULL,
	"deployer" varchar(42) NOT NULL,
	"pair_token" varchar(42) NOT NULL,
	"pool" varchar(42) NOT NULL,
	"launch_block" bigint NOT NULL,
	"launch_time" timestamp with time zone NOT NULL,
	"launch_tx" varchar(66) NOT NULL,
	"initializer" varchar(42),
	"pool_id" varchar(66),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tokens_address_unique" UNIQUE("address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trades" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain_id" integer NOT NULL,
	"token_id" integer NOT NULL,
	"wallet" varchar(42) NOT NULL,
	"side" "trade_side" NOT NULL,
	"quote_amount" numeric(78, 0) NOT NULL,
	"token_amount" numeric(78, 0) NOT NULL,
	"usd_value" numeric(38, 2),
	"block_number" bigint NOT NULL,
	"tx_hash" varchar(66) NOT NULL,
	"log_index" integer NOT NULL,
	"timestamp" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trades_chain_tx_log_unique" UNIQUE("chain_id","tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_watchlist" (
	"address" varchar(42) PRIMARY KEY NOT NULL,
	"name" varchar(256) NOT NULL,
	"type" "wallet_type" NOT NULL,
	"tier" "wallet_tier" NOT NULL,
	"owner_group" varchar(128) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_score_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"hot_candidate_id" integer NOT NULL,
	"score_at" timestamp with time zone NOT NULL,
	"age_ms" bigint NOT NULL,
	"breakout_score" numeric(4, 2) NOT NULL,
	"organic_score" numeric(4, 2) NOT NULL,
	"kol_score" numeric(4, 2) NOT NULL,
	"risk" varchar(16) NOT NULL,
	"confidence" varchar(16) NOT NULL,
	"breakdown" jsonb NOT NULL,
	"rule_version" integer NOT NULL,
	"gate_status" "gate_status" NOT NULL,
	"radar_state" "radar_state" NOT NULL,
	"protocol_state" "protocol_state" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_trader_aggregates" (
	"id" serial PRIMARY KEY NOT NULL,
	"hot_candidate_id" integer NOT NULL,
	"wallet" varchar(64) NOT NULL,
	"buy_volume_usd" numeric(38, 2) DEFAULT '0' NOT NULL,
	"sell_volume_usd" numeric(38, 2) DEFAULT '0' NOT NULL,
	"buy_count" integer DEFAULT 0 NOT NULL,
	"sell_count" integer DEFAULT 0 NOT NULL,
	"first_trade_at" timestamp with time zone NOT NULL,
	"last_trade_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_trader_aggregates_hot_candidate_wallet_unique" UNIQUE("hot_candidate_id","wallet")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chain_sources" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" "chain_key" NOT NULL,
	"source" varchar(32) NOT NULL,
	"role" varchar(32) NOT NULL,
	"address" varchar(64) NOT NULL,
	"event_name" varchar(128),
	"enabled" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chain_sources_chain_source_role_address_unique" UNIQUE("chain","source","role","address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "creator_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" "chain_key" NOT NULL,
	"creator" varchar(64) NOT NULL,
	"launches_total" integer DEFAULT 0 NOT NULL,
	"launches_24h" integer DEFAULT 0 NOT NULL,
	"graduated_count" integer,
	"survived_1h" integer,
	"survived_24h" integer,
	"survived_7d" integer,
	"early_sell_count" integer,
	"rug_like_count" integer,
	"median_peak_mc" numeric(38, 2),
	"last_launch_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "creator_profiles_chain_creator_unique" UNIQUE("chain","creator")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "hot_candidates" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" "chain_key" NOT NULL,
	"token_id" integer NOT NULL,
	"token_address" varchar(64) NOT NULL,
	"source" varchar(32) NOT NULL,
	"discovered_at" timestamp with time zone NOT NULL,
	"launched_at" timestamp with time zone NOT NULL,
	"launch_block_number" bigint,
	"launch_block_hash" varchar(66),
	"expires_at" timestamp with time zone NOT NULL,
	"radar_state" "radar_state" DEFAULT 'DISCOVERED' NOT NULL,
	"protocol_state" "protocol_state" DEFAULT 'UNKNOWN' NOT NULL,
	"gate_status" "gate_status" DEFAULT 'UNKNOWN_REVIEW' NOT NULL,
	"gate_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_breakout_score" numeric(4, 2),
	"latest_organic_score" numeric(4, 2),
	"latest_kol_score" numeric(4, 2),
	"latest_risk" varchar(16),
	"latest_confidence" varchar(16),
	"last_evaluated_at" timestamp with time zone,
	"invalidated" boolean DEFAULT false NOT NULL,
	"invalidated_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hot_candidates_chain_token_address_unique" UNIQUE("chain","token_address")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rpc_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"chain" "chain_key" NOT NULL,
	"snapshot_at" timestamp with time zone NOT NULL,
	"rpc_requests_1m" integer NOT NULL,
	"eth_get_logs_1m" integer NOT NULL,
	"eth_call_1m" integer NOT NULL,
	"eth_get_transaction_1m" integer NOT NULL,
	"eth_get_receipt_1m" integer NOT NULL,
	"eth_get_block_1m" integer NOT NULL,
	"ws_events_1m" integer NOT NULL,
	"estimated_credits_1m" numeric(20, 4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "token_lifecycle_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"hot_candidate_id" integer NOT NULL,
	"event_at" timestamp with time zone NOT NULL,
	"field" varchar(32) NOT NULL,
	"from_value" varchar(32),
	"to_value" varchar(32) NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "alerts" ADD CONSTRAINT "alerts_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "narrative_flags" ADD CONSTRAINT "narrative_flags_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signal_outcome_points" ADD CONSTRAINT "signal_outcome_points_signal_outcome_id_signal_outcomes_id_fk" FOREIGN KEY ("signal_outcome_id") REFERENCES "public"."signal_outcomes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signal_outcomes" ADD CONSTRAINT "signal_outcomes_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signal_outcomes" ADD CONSTRAINT "signal_outcomes_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signal_wallets" ADD CONSTRAINT "signal_wallets_signal_id_signals_id_fk" FOREIGN KEY ("signal_id") REFERENCES "public"."signals"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signals" ADD CONSTRAINT "signals_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_snapshots" ADD CONSTRAINT "token_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trades" ADD CONSTRAINT "trades_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_score_history" ADD CONSTRAINT "candidate_score_history_hot_candidate_id_hot_candidates_id_fk" FOREIGN KEY ("hot_candidate_id") REFERENCES "public"."hot_candidates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_trader_aggregates" ADD CONSTRAINT "candidate_trader_aggregates_hot_candidate_id_hot_candidates_id_fk" FOREIGN KEY ("hot_candidate_id") REFERENCES "public"."hot_candidates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_lifecycle_events" ADD CONSTRAINT "token_lifecycle_events_hot_candidate_id_hot_candidates_id_fk" FOREIGN KEY ("hot_candidate_id") REFERENCES "public"."hot_candidates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_token_id_channel_sent_at_idx" ON "alerts" USING btree ("token_id","channel","sent_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_outcome_points_pending_idx" ON "signal_outcome_points" USING btree ("recorded_at","due_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_outcomes_importance_idx" ON "signal_outcomes" USING btree ("importance_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_outcomes_risk_confidence_idx" ON "signal_outcomes" USING btree ("risk_level","confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_outcomes_baseline_available_idx" ON "signal_outcomes" USING btree ("baseline_available");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signals_token_id_triggered_at_idx" ON "signals" USING btree ("token_id","triggered_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_snapshots_token_id_snapshot_at_idx" ON "token_snapshots" USING btree ("token_id","snapshot_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_score_history_hot_candidate_id_score_at_idx" ON "candidate_score_history" USING btree ("hot_candidate_id","score_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_trader_aggregates_hot_candidate_id_idx" ON "candidate_trader_aggregates" USING btree ("hot_candidate_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hot_candidates_radar_state_idx" ON "hot_candidates" USING btree ("radar_state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "hot_candidates_expires_at_idx" ON "hot_candidates" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rpc_metrics_chain_snapshot_at_idx" ON "rpc_metrics" USING btree ("chain","snapshot_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_lifecycle_events_hot_candidate_id_event_at_idx" ON "token_lifecycle_events" USING btree ("hot_candidate_id","event_at");