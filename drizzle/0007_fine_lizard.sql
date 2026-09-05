CREATE TYPE "public"."alert_channel" AS ENUM('email', 'telegram');--> statement-breakpoint
CREATE TYPE "public"."delivery_status" AS ENUM('sent', 'failed');--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "signal_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "token_id" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "channel" "alert_channel" NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "sent_at" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "importance_at_send" numeric(4, 2) NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "risk_at_send" "risk_level";--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "confidence_at_send" "confidence_level";--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "trigger_reason" varchar(32) NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "delivery_status" "delivery_status" NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "error_message" text;--> statement-breakpoint
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
CREATE INDEX IF NOT EXISTS "alerts_token_id_channel_sent_at_idx" ON "alerts" USING btree ("token_id","channel","sent_at");