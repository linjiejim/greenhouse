-- Adopt the 3.0 table in place; disabling the plugin preserves its data.
CREATE TABLE IF NOT EXISTS "report_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cover_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'personal' NOT NULL,
	"owner_user_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_report_templates_kind" CHECK ("report_templates"."kind" IN ('report', 'presentation')),
	CONSTRAINT "chk_report_templates_visibility" CHECK ("report_templates"."visibility" IN ('team', 'personal'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_report_templates_visibility" ON "report_templates" USING btree ("visibility","updated_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_report_templates_owner" ON "report_templates" USING btree ("owner_user_id","updated_at");
