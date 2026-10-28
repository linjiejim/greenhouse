CREATE TABLE IF NOT EXISTS "feishu_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"feishu_key" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_feishu_conversations_key" UNIQUE("feishu_key"),
	CONSTRAINT "chk_feishu_conversations_chat_type" CHECK ("feishu_conversations"."chat_type" IN ('p2p', 'group'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feishu_receipts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "feishu_conversations" ADD CONSTRAINT "feishu_conversations_session_id_conversations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "feishu_conversations" ADD CONSTRAINT "feishu_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feishu_conversations_user" ON "feishu_conversations" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_feishu_receipts_received" ON "feishu_receipts" USING btree ("received_at");
