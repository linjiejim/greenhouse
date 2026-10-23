CREATE TABLE "service_usage" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"service" text NOT NULL,
	"provider" text NOT NULL,
	"model" text,
	"units" bigint DEFAULT 1 NOT NULL,
	"unit_kind" text NOT NULL,
	"cost_usd_micros" bigint,
	"client" text,
	"oauth_client_id" text,
	"caller" text DEFAULT '' NOT NULL,
	"run_id" text,
	"session_id" text,
	"budget_idempotency_key" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_budget_limits" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"unit" text DEFAULT 'usd_micros' NOT NULL,
	"limit_units" bigint NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_usage_budget_limits_nonnegative" CHECK ("usage_budget_limits"."limit_units" >= 0)
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "cost_usd_micros" bigint;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "service" text;--> statement-breakpoint
CREATE INDEX "idx_service_usage_user_created" ON "service_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_service_usage_service_created" ON "service_usage" USING btree ("service","created_at");--> statement-breakpoint
CREATE INDEX "idx_service_usage_created" ON "service_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_service_usage_budget_key" ON "service_usage" USING btree ("budget_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_budget_limits_scope" ON "usage_budget_limits" USING btree ("scope_type","scope_id","unit");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_user_created" ON "llm_usage" USING btree ("user_id","created_at");