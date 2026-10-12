CREATE TABLE "table_automation_secrets" (
	"rule_id" integer NOT NULL,
	"action_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "table_automation_secrets_rule_id_action_id_pk" PRIMARY KEY("rule_id","action_id")
);
--> statement-breakpoint
CREATE TABLE "table_base_group_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_id" integer NOT NULL,
	"group_id" integer NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"custom_role_id" integer,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_base_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"rules" jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_form_submissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"form_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"record_id" integer,
	"single_submit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"file_name" text NOT NULL,
	"header" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"rows" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'previewed' NOT NULL,
	"committed_rows" integer DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"result" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_record_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_id" integer NOT NULL,
	"table_id" integer NOT NULL,
	"author_id" text NOT NULL,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_record_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_id" integer NOT NULL,
	"table_id" integer NOT NULL,
	"actor_id" text,
	"actor_kind" text NOT NULL,
	"type" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_app_action_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"action_id" text NOT NULL,
	"page_id" text NOT NULL,
	"card_id" text NOT NULL,
	"record_id" integer,
	"status" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_app_audiences" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"principal_type" text NOT NULL,
	"user_id" text,
	"group_id" integer,
	"role_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_table_app_audiences_principal" CHECK (("table_app_audiences"."principal_type" = 'user' AND "table_app_audiences"."user_id" IS NOT NULL AND "table_app_audiences"."group_id" IS NULL)
        OR ("table_app_audiences"."principal_type" = 'group' AND "table_app_audiences"."group_id" IS NOT NULL AND "table_app_audiences"."user_id" IS NULL)
        OR ("table_app_audiences"."principal_type" = 'team' AND "table_app_audiences"."user_id" IS NULL AND "table_app_audiences"."group_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "table_app_pins" (
	"user_id" text NOT NULL,
	"app_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "table_app_pins_user_id_app_id_pk" PRIMARY KEY("user_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "table_app_template_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"template_id" integer NOT NULL,
	"version" text NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"custom_cards" integer DEFAULT 0 NOT NULL,
	"automations" integer DEFAULT 0 NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"scan_findings" jsonb,
	"scanned_at" timestamp with time zone,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"source_app_version" integer,
	"published_by" text,
	"published_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_app_templates" (
	"id" serial PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'app' NOT NULL,
	"accent" text DEFAULT 'brand' NOT NULL,
	"owner_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"latest_version" text,
	"source_app_id" integer,
	"source_base_id" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_app_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" integer NOT NULL,
	"version" integer NOT NULL,
	"spec" text NOT NULL,
	"spec_hash" text NOT NULL,
	"draft_revision" integer NOT NULL,
	"notes" text,
	"published_by" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"custom_review" jsonb
);
--> statement-breakpoint
CREATE TABLE "table_apps" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"icon" text DEFAULT 'app' NOT NULL,
	"accent" text DEFAULT 'brand' NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"draft_spec" text NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"audiences_revision" integer DEFAULT 1 NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ALTER COLUMN "record_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "scope_type" text;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "scope_id" text;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "trigger_kind" text DEFAULT 'record_created' NOT NULL;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "cursor" text;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "scheduled_for" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "rule_revision" integer;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD COLUMN "actions" jsonb;--> statement-breakpoint
ALTER TABLE "table_automation_rules" ADD COLUMN "next_fire_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "table_automation_rules" ADD COLUMN "swept_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "table_automation_runs" ADD COLUMN "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "table_automation_runs" ADD COLUMN "trigger_kind" text;--> statement-breakpoint
ALTER TABLE "table_automation_runs" ADD COLUMN "record_id" integer;--> statement-breakpoint
ALTER TABLE "table_base_members" ADD COLUMN "custom_role_id" integer;--> statement-breakpoint
ALTER TABLE "table_bases" ADD COLUMN "team_role" text DEFAULT 'viewer' NOT NULL;--> statement-breakpoint
ALTER TABLE "table_bases" ADD COLUMN "team_custom_role_id" integer;--> statement-breakpoint
ALTER TABLE "table_dashboards" ADD COLUMN "config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "table_forms" ADD COLUMN "audience" jsonb DEFAULT '{"type":"base"}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "kind" text DEFAULT 'rollup' NOT NULL;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "source_revision" integer;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "tokens" integer;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "table_automation_secrets" ADD CONSTRAINT "table_automation_secrets_rule_id_table_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."table_automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_base_group_members" ADD CONSTRAINT "table_base_group_members_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_base_group_members" ADD CONSTRAINT "table_base_group_members_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_base_group_members" ADD CONSTRAINT "table_base_group_members_custom_role_id_table_base_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."table_base_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_base_roles" ADD CONSTRAINT "table_base_roles_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_form_submissions" ADD CONSTRAINT "table_form_submissions_form_id_table_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."table_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_form_submissions" ADD CONSTRAINT "table_form_submissions_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_imports" ADD CONSTRAINT "table_imports_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_comments" ADD CONSTRAINT "table_record_comments_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_events" ADD CONSTRAINT "table_record_events_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_action_requests" ADD CONSTRAINT "table_app_action_requests_app_id_table_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."table_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_audiences" ADD CONSTRAINT "table_app_audiences_app_id_table_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."table_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_audiences" ADD CONSTRAINT "table_app_audiences_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_pins" ADD CONSTRAINT "table_app_pins_app_id_table_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."table_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_template_versions" ADD CONSTRAINT "table_app_template_versions_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."table_app_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_templates" ADD CONSTRAINT "table_app_templates_source_app_id_table_apps_id_fk" FOREIGN KEY ("source_app_id") REFERENCES "public"."table_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_templates" ADD CONSTRAINT "table_app_templates_source_base_id_table_bases_id_fk" FOREIGN KEY ("source_base_id") REFERENCES "public"."table_bases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_versions" ADD CONSTRAINT "table_app_versions_app_id_table_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."table_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_apps" ADD CONSTRAINT "table_apps_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_base_group_members_base_group" ON "table_base_group_members" USING btree ("base_id","group_id");--> statement-breakpoint
CREATE INDEX "idx_table_base_group_members_group" ON "table_base_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_base_roles_base_name" ON "table_base_roles" USING btree ("base_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_base_roles_base_id" ON "table_base_roles" USING btree ("base_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_form_submissions_single" ON "table_form_submissions" USING btree ("form_id","user_id") WHERE "table_form_submissions"."single_submit";--> statement-breakpoint
CREATE INDEX "idx_table_form_submissions_form_user" ON "table_form_submissions" USING btree ("form_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_table_form_submissions_record" ON "table_form_submissions" USING btree ("record_id");--> statement-breakpoint
CREATE INDEX "idx_table_imports_table" ON "table_imports" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "idx_table_imports_expires" ON "table_imports" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_table_record_comments_record" ON "table_record_comments" USING btree ("record_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_table_record_events_record" ON "table_record_events" USING btree ("record_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_action_requests_request" ON "table_app_action_requests" USING btree ("app_id","user_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_table_app_action_requests_app_created" ON "table_app_action_requests" USING btree ("app_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_audiences_user" ON "table_app_audiences" USING btree ("app_id","user_id") WHERE "table_app_audiences"."principal_type" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_audiences_group" ON "table_app_audiences" USING btree ("app_id","group_id") WHERE "table_app_audiences"."principal_type" = 'group';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_audiences_team" ON "table_app_audiences" USING btree ("app_id") WHERE "table_app_audiences"."principal_type" = 'team';--> statement-breakpoint
CREATE INDEX "idx_table_app_audiences_user" ON "table_app_audiences" USING btree ("user_id") WHERE "table_app_audiences"."principal_type" = 'user';--> statement-breakpoint
CREATE INDEX "idx_table_app_audiences_group" ON "table_app_audiences" USING btree ("group_id") WHERE "table_app_audiences"."principal_type" = 'group';--> statement-breakpoint
CREATE INDEX "idx_table_app_pins_app" ON "table_app_pins" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_template_versions_version" ON "table_app_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE INDEX "idx_table_app_template_versions_review" ON "table_app_template_versions" USING btree ("review_status","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_templates_key" ON "table_app_templates" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_table_app_templates_status" ON "table_app_templates" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_table_app_templates_owner" ON "table_app_templates" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_versions_app_version" ON "table_app_versions" USING btree ("app_id","version");--> statement-breakpoint
CREATE INDEX "idx_table_apps_base" ON "table_apps" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "idx_table_apps_owner" ON "table_apps" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_table_apps_featured" ON "table_apps" USING btree ("id") WHERE "table_apps"."featured";--> statement-breakpoint
ALTER TABLE "table_base_members" ADD CONSTRAINT "table_base_members_custom_role_id_table_base_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."table_base_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_bases" ADD CONSTRAINT "table_bases_team_custom_role_id_table_base_roles_id_fk" FOREIGN KEY ("team_custom_role_id") REFERENCES "public"."table_base_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_platform_audit_scope_created" ON "platform_audit_events" USING btree ("app_id","scope_type","scope_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_table_automation_outbox_claim" ON "table_automation_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "idx_table_automation_rules_next_fire" ON "table_automation_rules" USING btree ("status","next_fire_at");--> statement-breakpoint
CREATE INDEX "idx_table_recompute_jobs_claim" ON "table_recompute_jobs" USING btree ("kind","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_table_recompute_jobs_field" ON "table_recompute_jobs" USING btree ("field_id","status");
--> statement-breakpoint
-- Backfill: rows written by the synchronous executor carry their trigger in event_type.
UPDATE "table_automation_outbox" SET "trigger_kind" = "event_type" WHERE "trigger_kind" IS DISTINCT FROM "event_type";
--> statement-breakpoint
UPDATE "table_automation_runs" AS r SET "trigger_kind" = o."event_type", "record_id" = o."record_id" FROM "table_automation_outbox" AS o WHERE r."outbox_id" = o."id";
--> statement-breakpoint
-- Backfill: file the existing Tables write events under their Base, so the Base
-- audit feed (now one indexed read on scope_type / scope_id) keeps its history.
-- record_id carries the resource of each action's kind (apps/api
-- platform/tables/audit.ts TABLES_ACTION_RESOURCES); reads are not backfilled
-- (the feed lists writes only), and a resource deleted since resolves to nothing.
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = e."record_id"
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND e."record_id" ~ '^[0-9]+$'
  AND e."action_id" IN ('updateBase', 'archiveBase', 'manageMembers', 'transferBaseOwner', 'createRole', 'createTable', 'createAutomation', 'createDashboard');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = t."base_id"::text
FROM "table_tables" t
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND t."id"::text = e."record_id"
  AND e."action_id" IN ('updateTable', 'archiveTable', 'createField', 'createView', 'createForm', 'createRecord', 'batchUpsertRecords', 'previewImport', 'commitImport');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = t."base_id"::text
FROM "table_fields" f, "table_tables" t
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND f."id"::text = e."record_id" AND t."id" = f."table_id"
  AND e."action_id" IN ('updateField', 'archiveField');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = t."base_id"::text
FROM "table_views" v, "table_tables" t
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND v."id"::text = e."record_id" AND t."id" = v."table_id"
  AND e."action_id" IN ('updateView', 'deleteView');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = t."base_id"::text
FROM "table_forms" f, "table_tables" t
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND f."id"::text = e."record_id" AND t."id" = f."table_id"
  AND e."action_id" IN ('updateForm', 'submitForm');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = t."base_id"::text
FROM "table_records" r, "table_tables" t
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND r."id"::text = e."record_id" AND t."id" = r."table_id"
  AND e."action_id" IN ('updateRecord', 'deleteRecord', 'restoreRecord', 'createComment', 'triggerAutomation');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = t."base_id"::text
FROM "table_record_comments" rc, "table_tables" t
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND rc."id"::text = e."record_id" AND t."id" = rc."table_id"
  AND e."action_id" IN ('updateComment', 'deleteComment');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = r."base_id"::text
FROM "table_base_roles" r
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND r."id"::text = e."record_id"
  AND e."action_id" IN ('updateRole', 'deleteRole');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = a."base_id"::text
FROM "table_automation_rules" a
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND a."id"::text = e."record_id"
  AND e."action_id" IN ('updateAutomation', 'deleteAutomation');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = d."base_id"::text
FROM "table_dashboards" d
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND d."id"::text = e."record_id"
  AND e."action_id" IN ('updateDashboard', 'deleteDashboard', 'createDashboardWidget');--> statement-breakpoint
UPDATE "platform_audit_events" e SET "scope_type" = 'base', "scope_id" = d."base_id"::text
FROM "table_dashboard_widgets" w, "table_dashboards" d
WHERE e."app_id" = 'tables' AND e."scope_type" IS NULL AND w."id"::text = e."record_id" AND d."id" = w."dashboard_id"
  AND e."action_id" IN ('updateDashboardWidget', 'deleteDashboardWidget');
