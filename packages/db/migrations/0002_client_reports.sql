CREATE TABLE "client_reports" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_report_id" text NOT NULL,
	"fingerprint" text NOT NULL,
	"fatal" boolean NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"message" text NOT NULL,
	"stack" text,
	"route" text,
	"platform" text NOT NULL,
	"os_version" text,
	"app_version" text,
	"app_build" text,
	"api_level" integer,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_client_reports_source" CHECK ("client_reports"."source" IN ('global', 'promise', 'boundary', 'window', 'unclean_exit')),
	CONSTRAINT "chk_client_reports_platform" CHECK ("client_reports"."platform" IN ('ios', 'android', 'web', 'desktop'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_client_reports_user_client_id" ON "client_reports" USING btree ("user_id","client_report_id");--> statement-breakpoint
CREATE INDEX "idx_client_reports_created_at" ON "client_reports" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_client_reports_fingerprint_created_at" ON "client_reports" USING btree ("fingerprint","created_at");