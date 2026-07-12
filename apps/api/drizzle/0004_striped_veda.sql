ALTER TABLE "chat_messages" ADD COLUMN "moderated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "room_participants" ADD COLUMN "chat_banned_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_messages_room_hidden_idx" ON "chat_messages" USING btree ("room_id","hidden");