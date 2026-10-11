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
ALTER TABLE "table_recompute_jobs" ADD COLUMN "kind" text DEFAULT 'rollup' NOT NULL;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "lease_owner" text;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "input_hash" text;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "source_revision" integer;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "tokens" integer;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "table_app_template_versions" ADD CONSTRAINT "table_app_template_versions_template_fk" FOREIGN KEY ("template_id") REFERENCES "public"."table_app_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_templates" ADD CONSTRAINT "table_app_templates_source_app_id_table_apps_id_fk" FOREIGN KEY ("source_app_id") REFERENCES "public"."table_apps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_app_templates" ADD CONSTRAINT "table_app_templates_source_base_id_table_bases_id_fk" FOREIGN KEY ("source_base_id") REFERENCES "public"."table_bases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_template_versions_version" ON "table_app_template_versions" USING btree ("template_id","version");--> statement-breakpoint
CREATE INDEX "idx_table_app_template_versions_review" ON "table_app_template_versions" USING btree ("review_status","published_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_templates_key" ON "table_app_templates" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_table_app_templates_status" ON "table_app_templates" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_table_app_templates_owner" ON "table_app_templates" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_table_recompute_jobs_claim" ON "table_recompute_jobs" USING btree ("kind","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_table_recompute_jobs_field" ON "table_recompute_jobs" USING btree ("field_id","status");