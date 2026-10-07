CREATE TABLE "bot_computers" (
	"user_id" text PRIMARY KEY NOT NULL,
	"namespace" text NOT NULL,
	"container_name" text NOT NULL,
	"volume_name" text NOT NULL,
	"state" text DEFAULT 'absent' NOT NULL,
	"state_reason" text,
	"version" integer DEFAULT 0 NOT NULL,
	"lease_controller" text DEFAULT 'bot' NOT NULL,
	"lease_epoch" integer DEFAULT 0 NOT NULL,
	"lease_since" timestamp with time zone,
	"viewer_heartbeat_at" timestamp with time zone,
	"last_active_at" timestamp with time zone NOT NULL,
	"last_started_at" timestamp with time zone,
	"image_id" text,
	"disk_bytes" bigint,
	"disk_measured_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_conversation_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"bot_id" text NOT NULL,
	"role" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"added_by" text DEFAULT 'user' NOT NULL,
	"joined_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_conversations" (
	"session_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"owner_bot_id" text,
	"lead_bot_id" text,
	"title" text,
	"description" text DEFAULT '' NOT NULL,
	"allow_bot_chat" boolean DEFAULT true NOT NULL,
	"digest" text DEFAULT '' NOT NULL,
	"digest_upto_seq" integer DEFAULT 0 NOT NULL,
	"digest_upto_message_id" text,
	"digest_updated_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	"last_activity_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_inbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "bot_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"bot_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"result" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_shared_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author_bot_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bots" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"instructions" text DEFAULT '' NOT NULL,
	"avatar" text DEFAULT '{}' NOT NULL,
	"model_id" text,
	"template_key" text,
	"status" text DEFAULT 'active' NOT NULL,
	"last_active_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_access_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"item_id" text,
	"item_label" text NOT NULL,
	"bot_id" text,
	"session_id" text,
	"origin" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"approval" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_items" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text NOT NULL,
	"origins" text DEFAULT '[]' NOT NULL,
	"username_enc" text,
	"username_hint" text DEFAULT '' NOT NULL,
	"password_enc" text,
	"totp_enc" text,
	"policy" text DEFAULT 'ask' NOT NULL,
	"always_origins" text DEFAULT '[]' NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "bot_event" text;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "bot_computers" ADD CONSTRAINT "bot_computers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_conversation_members" ADD CONSTRAINT "bot_conversation_members_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_conversation_members" ADD CONSTRAINT "bot_conversation_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_conversation_members" ADD CONSTRAINT "bot_conversation_members_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_conversations" ADD CONSTRAINT "bot_conversations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_conversations" ADD CONSTRAINT "bot_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_conversations" ADD CONSTRAINT "bot_conversations_owner_bot_id_bots_id_fk" FOREIGN KEY ("owner_bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_conversations" ADD CONSTRAINT "bot_conversations_lead_bot_id_bots_id_fk" FOREIGN KEY ("lead_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_inbox" ADD CONSTRAINT "bot_inbox_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_requests" ADD CONSTRAINT "bot_requests_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_shared_notes" ADD CONSTRAINT "bot_shared_notes_session_id_bot_conversations_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."bot_conversations"("session_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_shared_notes" ADD CONSTRAINT "bot_shared_notes_author_bot_id_bots_id_fk" FOREIGN KEY ("author_bot_id") REFERENCES "public"."bots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bots" ADD CONSTRAINT "bots_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access_log" ADD CONSTRAINT "vault_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access_log" ADD CONSTRAINT "vault_access_log_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vault_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_conversation_members" ON "bot_conversation_members" USING btree ("session_id","bot_id");--> statement-breakpoint
CREATE INDEX "idx_bot_conversation_members_bot" ON "bot_conversation_members" USING btree ("bot_id");--> statement-breakpoint
CREATE INDEX "idx_bot_conversations_user" ON "bot_conversations" USING btree ("user_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bot_conversations_owner_bot" ON "bot_conversations" USING btree ("owner_bot_id");--> statement-breakpoint
CREATE INDEX "idx_bot_inbox_pending" ON "bot_inbox" USING btree ("session_id","id") WHERE "bot_inbox"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_bot_requests_user_status" ON "bot_requests" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_bot_requests_session" ON "bot_requests" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "idx_bot_shared_notes_session" ON "bot_shared_notes" USING btree ("session_id","status");--> statement-breakpoint
CREATE INDEX "idx_bots_user" ON "bots" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_bots_user_name_active" ON "bots" USING btree ("user_id","name_key") WHERE "bots"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_vault_access_log_user" ON "vault_access_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_vault_items_user" ON "vault_items" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_messages_bot" ON "messages" USING btree ("bot_id") WHERE "messages"."bot_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_user_memories_bot" ON "user_memories" USING btree ("bot_id") WHERE "user_memories"."bot_id" IS NOT NULL;