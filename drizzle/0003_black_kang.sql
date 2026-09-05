CREATE TYPE "public"."wallet_tier" AS ENUM('A', 'B', 'C');--> statement-breakpoint
CREATE TYPE "public"."wallet_type" AS ENUM('KOL', 'FOMO_TRADER', 'SMART_MONEY');--> statement-breakpoint
ALTER TABLE "wallet_watchlist" DROP COLUMN IF EXISTS "id";--> statement-breakpoint
ALTER TABLE "wallet_watchlist" ADD COLUMN "address" varchar(42) PRIMARY KEY NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_watchlist" ADD COLUMN "name" varchar(256) NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_watchlist" ADD COLUMN "type" "wallet_type" NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_watchlist" ADD COLUMN "tier" "wallet_tier" NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_watchlist" ADD COLUMN "owner_group" varchar(128) NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_watchlist" ADD COLUMN "enabled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "wallet_watchlist" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "wallet_watchlist" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;