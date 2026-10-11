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
ALTER TABLE "table_app_action_requests" ADD CONSTRAINT "table_app_action_requests_app_id_table_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."table_apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_app_action_requests_request" ON "table_app_action_requests" USING btree ("app_id","user_id","request_id");--> statement-breakpoint
CREATE INDEX "idx_table_app_action_requests_app_created" ON "table_app_action_requests" USING btree ("app_id","created_at");