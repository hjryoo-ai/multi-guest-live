ALTER TABLE "moderation_logs" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "rooms" ADD COLUMN "max_speakers" integer DEFAULT 20 NOT NULL;