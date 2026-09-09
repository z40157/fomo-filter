CREATE TYPE "public"."outcome_offset" AS ENUM('5m', '15m', '30m', '1h', '2h', '6h', '24h');--> statement-breakpoint
CREATE TYPE "public"."outcome_point_status" AS ENUM('PENDING', 'DONE', 'SKIPPED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "candidate_outcome_points" (
	"id" serial PRIMARY KEY NOT NULL,
	"hot_candidate_id" integer NOT NULL,
	"offset_label" "outcome_offset" NOT NULL,
	"baseline_at" timestamp with time zone NOT NULL,
	"baseline_price" numeric(38, 18),
	"scheduled_at" timestamp with time zone NOT NULL,
	"status" "outcome_point_status" DEFAULT 'PENDING' NOT NULL,
	"sampled_at" timestamp with time zone,
	"price" numeric(38, 18),
	"return_pct" numeric(12, 4),
	"max_return_pct" numeric(12, 4),
	"max_drawdown_pct" numeric(12, 4),
	"liquidity_usd" numeric(38, 2),
	"volume_usd" numeric(38, 2),
	"holders" integer,
	"data_source" varchar(32),
	"data_status" varchar(16) DEFAULT 'UNKNOWN' NOT NULL,
	"data_status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "candidate_outcome_points_hot_candidate_id_offset_label_unique" UNIQUE("hot_candidate_id","offset_label")
);
--> statement-breakpoint
ALTER TABLE "candidate_score_history" ADD COLUMN "gate_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_score_history" ADD COLUMN "tier" varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_score_history" ADD COLUMN "tier_uncapped" varchar(16) NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_score_history" ADD COLUMN "features" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "candidate_score_history" ADD COLUMN "data_status" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "rpc_metrics" ADD COLUMN "category" varchar(16) DEFAULT 'hot' NOT NULL;--> statement-breakpoint
ALTER TABLE "token_lifecycle_events" ADD COLUMN "age_ms" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "token_lifecycle_events" ADD COLUMN "reason_detail" jsonb;--> statement-breakpoint
ALTER TABLE "token_lifecycle_events" ADD COLUMN "gate_reasons" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "candidate_outcome_points" ADD CONSTRAINT "candidate_outcome_points_hot_candidate_id_hot_candidates_id_fk" FOREIGN KEY ("hot_candidate_id") REFERENCES "public"."hot_candidates"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "candidate_outcome_points_status_scheduled_at_idx" ON "candidate_outcome_points" USING btree ("status","scheduled_at");