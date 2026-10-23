CREATE TABLE "report_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"formats" text DEFAULT '[]' NOT NULL,
	"sections" text DEFAULT '[]' NOT NULL,
	"cover_fields" text DEFAULT '[]' NOT NULL,
	"visibility" text DEFAULT 'personal' NOT NULL,
	"owner_user_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "idx_report_templates_visibility" ON "report_templates" USING btree ("visibility","updated_at");--> statement-breakpoint
CREATE INDEX "idx_report_templates_owner" ON "report_templates" USING btree ("owner_user_id","updated_at");