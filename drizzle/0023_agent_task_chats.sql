DROP INDEX "uq_bot_conversations_owner_bot";--> statement-breakpoint
ALTER TABLE "bot_conversations" ADD COLUMN "model_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_conversations_owner_bot" ON "bot_conversations" USING btree ("owner_bot_id") WHERE "bot_conversations"."kind" = 'direct';