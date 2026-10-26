-- Adopt the 3.0 table in place; disabling the plugin preserves its data.
CREATE TABLE IF NOT EXISTS "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category" text DEFAULT 'preference' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"superseded_by" text,
	"source_session_id" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_memories_category" CHECK ("memories"."category" IN ('preference', 'fact', 'behavior')),
	CONSTRAINT "chk_memories_status" CHECK ("memories"."status" IN ('active', 'dormant', 'archived', 'superseded')),
	CONSTRAINT "chk_memories_source" CHECK ("memories"."source" IN ('user', 'agent', 'consolidation'))
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_user_id_users_id_fk' AND conrelid = 'memories'::regclass) THEN
  ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_superseded_by_memories_id_fk' AND conrelid = 'memories'::regclass) THEN
  ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_user_status" ON "memories" USING btree ("user_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_memories_user_category" ON "memories" USING btree ("user_id","category");
