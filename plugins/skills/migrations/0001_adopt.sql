-- Adopt existing 3.0 tables without moving or deleting data.
CREATE TABLE IF NOT EXISTS "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"changelog" text NOT NULL,
	"file_count" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_user_id" text NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"scan_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scan_version" text,
	"scanned_at" timestamp with time zone,
	"scan_reviewed_by" text,
	"scan_reviewed_at" timestamp with time zone,
	"scan_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_skills_status" CHECK ("skills"."status" IN ('active', 'archived')),
	CONSTRAINT "chk_skills_scan_status" CHECK ("skills"."scan_status" IN ('pending', 'clean', 'suspicious', 'blocked'))
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'skill_versions_skill_id_skills_id_fk' AND conrelid = 'skill_versions'::regclass) THEN
  ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_skill_versions_skill_version" ON "skill_versions" USING btree ("skill_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skill_versions_skill" ON "skill_versions" USING btree ("skill_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_skills_name" ON "skills" USING btree ("name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skills_status" ON "skills" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skills_updated_at" ON "skills" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_skills_scan_status" ON "skills" USING btree ("scan_status");
