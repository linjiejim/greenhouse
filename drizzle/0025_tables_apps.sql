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
ALTER TABLE "platform_audit_events" ADD COLUMN "scope_type" text;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "scope_id" text;--> statement-breakpoint
ALTER TABLE "table_app_audiences" ADD CONSTRAINT "table_app_audiences_app_id_table_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."table_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_audiences" ADD CONSTRAINT "table_app_audiences_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_pins" ADD CONSTRAINT "table_app_pins_app_id_table_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."table_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_versions" ADD CONSTRAINT "table_app_versions_app_id_table_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."table_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_apps" ADD CONSTRAINT "table_apps_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_audiences_user" ON "table_app_audiences" USING btree ("app_id","user_id") WHERE "table_app_audiences"."principal_type" = 'user';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_audiences_group" ON "table_app_audiences" USING btree ("app_id","group_id") WHERE "table_app_audiences"."principal_type" = 'group';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_audiences_team" ON "table_app_audiences" USING btree ("app_id") WHERE "table_app_audiences"."principal_type" = 'team';--> statement-breakpoint
CREATE INDEX "idx_table_app_audiences_user" ON "table_app_audiences" USING btree ("user_id") WHERE "table_app_audiences"."principal_type" = 'user';--> statement-breakpoint
CREATE INDEX "idx_table_app_audiences_group" ON "table_app_audiences" USING btree ("group_id") WHERE "table_app_audiences"."principal_type" = 'group';--> statement-breakpoint
CREATE INDEX "idx_table_app_pins_app" ON "table_app_pins" USING btree ("app_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_versions_app_version" ON "table_app_versions" USING btree ("app_id","version");--> statement-breakpoint
CREATE INDEX "idx_table_apps_base" ON "table_apps" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "idx_table_apps_owner" ON "table_apps" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_table_apps_featured" ON "table_apps" USING btree ("id") WHERE "table_apps"."featured";--> statement-breakpoint
CREATE INDEX "idx_platform_audit_scope_created" ON "platform_audit_events" USING btree ("app_id","scope_type","scope_id","created_at");--> statement-breakpoint
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
