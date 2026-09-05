CREATE TYPE "public"."signal_trigger_condition" AS ENUM('A', 'B', 'C');--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD COLUMN "signal_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD COLUMN "wallet_address" varchar(42) NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD COLUMN "wallet_name" varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD COLUMN "tier" "wallet_tier" NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD COLUMN "owner_group" varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD COLUMN "buy_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signal_wallets" ADD COLUMN "buy_amount" numeric(78, 0) NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "token_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "triggered_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "trigger_conditions" "signal_trigger_condition"[] NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "distinct_owner_groups" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "tier_a_count" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "has_repeat_accumulation" boolean NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "window_minutes" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "escalation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "market_cap" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "liquidity" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "volume_5m" numeric(38, 2);--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "signals_token_id_triggered_at_idx" ON "signals" USING btree ("token_id","triggered_at");