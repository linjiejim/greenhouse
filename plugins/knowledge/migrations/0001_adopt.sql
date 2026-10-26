-- Adopt the 3.0 tables in place. Disabling knowledge preserves every row.
CREATE TABLE IF NOT EXISTS "kb_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"scope" text DEFAULT 'shared' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text,
	"visibility" text DEFAULT 'team' NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_path" text,
	"folder_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"owner_user_id" text,
	"created_by" text,
	"updated_by" text,
	"_summary" text DEFAULT '' NOT NULL,
	"_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"_enriched_at" timestamp with time zone,
	"search_a" text DEFAULT '' NOT NULL,
	"search_b" text DEFAULT '' NOT NULL,
	"search_c" text DEFAULT '' NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', search_a), 'A') || setweight(to_tsvector('simple', search_b), 'B') || setweight(to_tsvector('simple', search_c), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_kb_documents_visibility" CHECK ("kb_documents"."visibility" IN ('team', 'private')),
	CONSTRAINT "chk_kb_documents_status" CHECK ("kb_documents"."status" IN ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "kb_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"changed_by" text,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kb_documents_folder_id_folders_id_fk' AND conrelid = 'kb_documents'::regclass) THEN
  ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'kb_versions_doc_id_kb_documents_id_fk' AND conrelid = 'kb_versions'::regclass) THEN
  ALTER TABLE "kb_versions" ADD CONSTRAINT "kb_versions_doc_id_kb_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_kb_documents_doc_scope" ON "kb_documents" USING btree ("doc_id","scope");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_documents_visibility" ON "kb_documents" USING btree ("visibility","owner_user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_documents_status" ON "kb_documents" USING btree ("status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_documents_updated_at" ON "kb_documents" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_documents_folder" ON "kb_documents" USING btree ("folder_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_documents_search" ON "kb_documents" USING gin ("search_tsv");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_kb_versions_doc_version" ON "kb_versions" USING btree ("doc_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_kb_versions_created_at" ON "kb_versions" USING btree ("created_at");
