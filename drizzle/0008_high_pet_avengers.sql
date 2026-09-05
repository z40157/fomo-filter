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
ALTER TABLE "signal_outcomes" ADD COLUMN "signal_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "token_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "baseline_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "baseline_price" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "baseline_market_cap" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "baseline_liquidity" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "baseline_available" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "importance_score" numeric(4, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "risk_level" "risk_level";--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "confidence" "confidence_level";--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "score_breakdown" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "scoring_rule_version" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "max_price" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "max_return_pct" numeric(16, 4);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "min_price" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "max_drawdown_pct" numeric(16, 4);--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "signal_outcome_points" ADD CONSTRAINT "signal_outcome_points_signal_outcome_id_signal_outcomes_id_fk" FOREIGN KEY ("signal_outcome_id") REFERENCES "public"."signal_outcomes"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_outcome_points_pending_idx" ON "signal_outcome_points" USING btree ("recorded_at","due_at");--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "signal_outcomes_importance_idx" ON "signal_outcomes" USING btree ("importance_score");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_outcomes_risk_confidence_idx" ON "signal_outcomes" USING btree ("risk_level","confidence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "signal_outcomes_baseline_available_idx" ON "signal_outcomes" USING btree ("baseline_available");--> statement-breakpoint
ALTER TABLE "signal_outcomes" ADD CONSTRAINT "signal_outcomes_signal_id_unique" UNIQUE("signal_id");