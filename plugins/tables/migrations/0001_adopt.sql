-- Adopt existing 3.0 tables without moving or deleting data.
CREATE TABLE IF NOT EXISTS "table_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "chk_table_bases_visibility" CHECK ("table_bases"."visibility" IN ('private', 'team'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_field_dependencies" (
	"field_id" text NOT NULL,
	"depends_on_field_id" text NOT NULL,
	"dependency_type" text NOT NULL,
	CONSTRAINT "table_field_dependencies_field_id_depends_on_field_id_pk" PRIMARY KEY("field_id","depends_on_field_id"),
	CONSTRAINT "chk_table_field_dependencies_type" CHECK ("table_field_dependencies"."dependency_type" IN ('formula', 'lookup', 'rollup'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "chk_table_fields_type" CHECK ("table_fields"."type" IN ('text', 'long_text', 'number', 'boolean', 'date', 'datetime', 'single_select', 'multi_select', 'user', 'multi_user', 'url', 'email', 'phone', 'attachment', 'relation', 'formula', 'rollup'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_recompute_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"field_id" text,
	"record_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "chk_table_recompute_jobs_status" CHECK ("table_recompute_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_record_links" (
	"id" text PRIMARY KEY NOT NULL,
	"field_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"target_record_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_records" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_revision" integer DEFAULT 1 NOT NULL,
	"computed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_schema_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"version" integer NOT NULL,
	"schema_snapshot" jsonb NOT NULL,
	"change_type" text NOT NULL,
	"changed_by" text NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_table_schema_versions_change" CHECK ("table_schema_versions"."change_type" IN ('created', 'field_created', 'field_updated', 'field_archived'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"schema_revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "table_views" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'grid' NOT NULL,
	"scope" text DEFAULT 'shared' NOT NULL,
	"owner_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_table_views_type" CHECK ("table_views"."type" IN ('grid')),
	CONSTRAINT "chk_table_views_scope" CHECK ("table_views"."scope" IN ('shared', 'personal'))
);
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_field_dependencies_field_id_table_fields_id_fk' AND conrelid = 'table_field_dependencies'::regclass) THEN
  ALTER TABLE "table_field_dependencies" ADD CONSTRAINT "table_field_dependencies_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_field_dependencies_depends_on_field_id_table_fields_id_fk' AND conrelid = 'table_field_dependencies'::regclass) THEN
  ALTER TABLE "table_field_dependencies" ADD CONSTRAINT "table_field_dependencies_depends_on_field_id_table_fields_id_fk" FOREIGN KEY ("depends_on_field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_fields_table_id_table_tables_id_fk' AND conrelid = 'table_fields'::regclass) THEN
  ALTER TABLE "table_fields" ADD CONSTRAINT "table_fields_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_recompute_jobs_table_id_table_tables_id_fk' AND conrelid = 'table_recompute_jobs'::regclass) THEN
  ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_recompute_jobs_field_id_table_fields_id_fk' AND conrelid = 'table_recompute_jobs'::regclass) THEN
  ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_recompute_jobs_record_id_table_records_id_fk' AND conrelid = 'table_recompute_jobs'::regclass) THEN
  ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_record_links_field_id_table_fields_id_fk' AND conrelid = 'table_record_links'::regclass) THEN
  ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_record_links_source_record_id_table_records_id_fk' AND conrelid = 'table_record_links'::regclass) THEN
  ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_source_record_id_table_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_record_links_target_record_id_table_records_id_fk' AND conrelid = 'table_record_links'::regclass) THEN
  ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_target_record_id_table_records_id_fk" FOREIGN KEY ("target_record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_records_table_id_table_tables_id_fk' AND conrelid = 'table_records'::regclass) THEN
  ALTER TABLE "table_records" ADD CONSTRAINT "table_records_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_schema_versions_table_id_table_tables_id_fk' AND conrelid = 'table_schema_versions'::regclass) THEN
  ALTER TABLE "table_schema_versions" ADD CONSTRAINT "table_schema_versions_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_tables_base_id_table_bases_id_fk' AND conrelid = 'table_tables'::regclass) THEN
  ALTER TABLE "table_tables" ADD CONSTRAINT "table_tables_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'table_views_table_id_table_tables_id_fk' AND conrelid = 'table_views'::regclass) THEN
  ALTER TABLE "table_views" ADD CONSTRAINT "table_views_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;
 END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_bases_owner" ON "table_bases" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_bases_visibility" ON "table_bases" USING btree ("visibility");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_bases_updated" ON "table_bases" USING btree ("updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_field_dependencies_source" ON "table_field_dependencies" USING btree ("depends_on_field_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_table_fields_table_name" ON "table_fields" USING btree ("table_id","name");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_table_fields_primary" ON "table_fields" USING btree ("table_id") WHERE "table_fields"."is_primary" = true AND "table_fields"."archived_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_fields_table_position" ON "table_fields" USING btree ("table_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_table_recompute_jobs_idempotency" ON "table_recompute_jobs" USING btree ("idempotency_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_recompute_jobs_status" ON "table_recompute_jobs" USING btree ("status","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_table_record_links_field_source_target" ON "table_record_links" USING btree ("field_id","source_record_id","target_record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_record_links_source" ON "table_record_links" USING btree ("field_id","source_record_id","position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_record_links_target" ON "table_record_links" USING btree ("field_id","target_record_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_records_table_created" ON "table_records" USING btree ("table_id","created_at","id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_records_table_updated" ON "table_records" USING btree ("table_id","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_records_deleted" ON "table_records" USING btree ("table_id","deleted_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_table_schema_versions_table_version" ON "table_schema_versions" USING btree ("table_id","version");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_schema_versions_table_created" ON "table_schema_versions" USING btree ("table_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_table_tables_base_name" ON "table_tables" USING btree ("base_id","name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_tables_base_position" ON "table_tables" USING btree ("base_id","position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_views_table_position" ON "table_views" USING btree ("table_id","position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_table_views_owner" ON "table_views" USING btree ("owner_id");
