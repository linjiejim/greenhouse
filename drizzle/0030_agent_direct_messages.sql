CREATE TABLE "bot_agent_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"dedupe_key" text NOT NULL,
	"chain_key" text NOT NULL,
	"parent_id" text,
	"path" text NOT NULL,
	"requester_id" text NOT NULL,
	"source_session_id" text NOT NULL,
	"source_bot_id" text NOT NULL,
	"target_session_id" text NOT NULL,
	"target_bot_id" text NOT NULL,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"reply" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"returned_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bot_agent_messages" ADD CONSTRAINT "bot_agent_messages_requester_id_users_id_fk" FOREIGN KEY ("requester_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_agent_messages" ADD CONSTRAINT "bot_agent_messages_source_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("source_session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_agent_messages" ADD CONSTRAINT "bot_agent_messages_source_bot_id_bots_id_fk" FOREIGN KEY ("source_bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_agent_messages" ADD CONSTRAINT "bot_agent_messages_target_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("target_session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_agent_messages" ADD CONSTRAINT "bot_agent_messages_target_bot_id_bots_id_fk" FOREIGN KEY ("target_bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_agent_message_dedupe" ON "bot_agent_messages" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_agent_message_target" ON "bot_agent_messages" USING btree ("target_session_id");--> statement-breakpoint
CREATE INDEX "idx_bot_agent_message_chain" ON "bot_agent_messages" USING btree ("chain_key");--> statement-breakpoint
CREATE INDEX "idx_bot_agent_message_pending" ON "bot_agent_messages" USING btree ("returned_at","updated_at");