CREATE TABLE "bot_message_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"status" text NOT NULL,
	"processed_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_message_receipts" ADD CONSTRAINT "bot_message_receipts_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_message_receipts" ADD CONSTRAINT "bot_message_receipts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_message_receipts" ADD CONSTRAINT "bot_message_receipts_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_message_receipt" ON "bot_message_receipts" USING btree ("message_id","bot_id");--> statement-breakpoint
CREATE INDEX "idx_bot_message_receipts_session" ON "bot_message_receipts" USING btree ("session_id");