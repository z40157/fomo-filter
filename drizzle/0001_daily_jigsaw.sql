CREATE TYPE "public"."launch_source" AS ENUM('doppler', 'pons_v1');--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "address" varchar(42) NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "symbol" varchar(64);--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "name" varchar(256);--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "launch_source" "launch_source" NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "deployer" varchar(42) NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "pair_token" varchar(42) NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "pool" varchar(42) NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "launch_block" bigint NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "launch_time" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD COLUMN "launch_tx" varchar(66) NOT NULL;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_address_unique" UNIQUE("address");