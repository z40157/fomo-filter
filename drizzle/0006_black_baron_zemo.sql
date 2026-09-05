CREATE TYPE "public"."confidence_level" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL', 'UNKNOWN');--> statement-breakpoint
ALTER TABLE "narrative_flags" ADD COLUMN "token_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "narrative_flags" ADD COLUMN "boost" numeric(3, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "narrative_flags" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "importance_score" numeric(4, 2);--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "score_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "risk_level" "risk_level";--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "risk_breakdown" jsonb;--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "confidence" "confidence_level";--> statement-breakpoint
ALTER TABLE "signals" ADD COLUMN "confidence_reasons" jsonb;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "narrative_flags" ADD CONSTRAINT "narrative_flags_token_id_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."tokens"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
