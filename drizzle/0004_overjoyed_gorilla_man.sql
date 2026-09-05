ALTER TABLE "token_snapshots" ADD COLUMN "token_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "price" numeric(38, 18);--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "market_cap" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "liquidity" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "volume_5m" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "volume_1h" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "buys_5m" integer;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "sells_5m" integer;--> statement-breakpoint
ALTER TABLE "token_snapshots" ADD COLUMN "snapshot_at" timestamp with time zone NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "token_snapshots" ADD CONSTRAINT "token_snapshots_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "token_snapshots_token_id_snapshot_at_idx" ON "token_snapshots" USING btree ("token_id","snapshot_at");