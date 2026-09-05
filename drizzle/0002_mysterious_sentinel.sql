CREATE TYPE "public"."trade_side" AS ENUM('BUY', 'SELL');--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "initializer" varchar(42);--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "pool_id" varchar(66);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "chain_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "token_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "wallet" varchar(42) NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "side" "trade_side" NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "quote_amount" numeric(78, 0) NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "token_amount" numeric(78, 0) NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "usd_value" numeric(38, 2);--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "block_number" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "tx_hash" varchar(66) NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "log_index" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "trades" ADD COLUMN "timestamp" timestamp with time zone NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trades" ADD CONSTRAINT "trades_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "trades" ADD CONSTRAINT "trades_chain_tx_log_unique" UNIQUE("chain_id","tx_hash","log_index");