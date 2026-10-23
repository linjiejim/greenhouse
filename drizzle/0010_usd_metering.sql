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
	"price_applied" text,
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
CREATE TABLE "usage_price_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"input_per_mtok" double precision,
	"output_per_mtok" double precision,
	"cached_input_per_mtok" double precision,
	"unit_price" double precision,
	"updated_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_usage_price_overrides_nonnegative" CHECK (COALESCE("usage_price_overrides"."input_per_mtok", 0) >= 0 AND COALESCE("usage_price_overrides"."output_per_mtok", 0) >= 0 AND COALESCE("usage_price_overrides"."cached_input_per_mtok", 0) >= 0 AND COALESCE("usage_price_overrides"."unit_price", 0) >= 0)
);
--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "cost_usd_micros" bigint;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "client" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "oauth_client_id" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "service" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "price_applied" text;--> statement-breakpoint
CREATE INDEX "idx_service_usage_user_created" ON "service_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_service_usage_service_created" ON "service_usage" USING btree ("service","created_at");--> statement-breakpoint
CREATE INDEX "idx_service_usage_created" ON "service_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_service_usage_budget_key" ON "service_usage" USING btree ("budget_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_budget_limits_scope" ON "usage_budget_limits" USING btree ("scope_type","scope_id","unit");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_price_overrides_target" ON "usage_price_overrides" USING btree ("kind","target","provider");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_user_created" ON "llm_usage" USING btree ("user_id","created_at");