-- Adopt the 3.0 table in place; disabling the plugin preserves its data.
CREATE TABLE IF NOT EXISTS "member_computers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'e2b' NOT NULL,
	"sandbox_id" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"minutes_billed" integer DEFAULT 0 NOT NULL,
	"budget_key" text,
	"block_started_at" timestamp with time zone,
	"client" text NOT NULL,
	"oauth_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_member_computers_status" CHECK ("member_computers"."status" IN ('starting', 'running', 'stopping', 'stopped', 'failed', 'lost'))
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_computers_user_id_users_id_fk' AND conrelid = 'member_computers'::regclass) THEN
  ALTER TABLE "member_computers" ADD CONSTRAINT "member_computers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_member_computers_active_user" ON "member_computers" USING btree ("user_id") WHERE "member_computers"."status" IN ('starting', 'running', 'stopping');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_member_computers_status" ON "member_computers" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_member_computers_user_started" ON "member_computers" USING btree ("user_id","started_at");
