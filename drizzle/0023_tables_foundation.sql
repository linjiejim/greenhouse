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
ALTER TABLE "table_automation_outbox" ALTER COLUMN "record_id" DROP NOT NULL;--> statement-breakpoint
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
-- Backfill: rows written by the synchronous executor carry their trigger in event_type.
UPDATE "table_automation_outbox" SET "trigger_kind" = "event_type" WHERE "trigger_kind" IS DISTINCT FROM "event_type";--> statement-breakpoint
UPDATE "table_automation_runs" AS r SET "trigger_kind" = o."event_type", "record_id" = o."record_id" FROM "table_automation_outbox" AS o WHERE r."outbox_id" = o."id";--> statement-breakpoint
ALTER TABLE "table_forms" ADD COLUMN "audience" jsonb DEFAULT '{"type":"base"}'::jsonb NOT NULL;--> statement-breakpoint
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
ALTER TABLE "table_base_members" ADD CONSTRAINT "table_base_members_custom_role_id_table_base_roles_id_fk" FOREIGN KEY ("custom_role_id") REFERENCES "public"."table_base_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_bases" ADD CONSTRAINT "table_bases_team_custom_role_id_table_base_roles_id_fk" FOREIGN KEY ("team_custom_role_id") REFERENCES "public"."table_base_roles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_table_automation_outbox_claim" ON "table_automation_outbox" USING btree ("status","available_at");--> statement-breakpoint
CREATE INDEX "idx_table_automation_rules_next_fire" ON "table_automation_rules" USING btree ("status","next_fire_at");