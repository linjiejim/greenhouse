CREATE TABLE "usage_counters" (
	"day" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"client" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "pk_usage_counters" PRIMARY KEY("day","kind","key","client")
);
--> statement-breakpoint
CREATE TABLE "agent_write_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text,
	"tool_id" text NOT NULL,
	"action" text,
	"created_via" text DEFAULT 'approval' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"use_count" integer DEFAULT 0 NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_login_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "digest" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "digest_upto_seq" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "digest_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "quiet_when_empty" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_write_grants" ADD CONSTRAINT "agent_write_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_write_grants" ADD CONSTRAINT "agent_write_grants_client_id_platform_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."platform_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_usage_counters_kind_day" ON "usage_counters" USING btree ("kind","day");--> statement-breakpoint
CREATE INDEX "idx_agent_write_grants_user_tool" ON "agent_write_grants" USING btree ("user_id","tool_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_login_states_expires" ON "oauth_login_states" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_rate_limit_buckets_expires" ON "rate_limit_buckets" USING btree ("expires_at");--> statement-breakpoint
-- v1.4 drops the custom-agent review lifecycle: team visibility becomes `is_shared` alone.
-- Rows that were shared but never reached pilot/verified were not visible to the team; keep it that way.
UPDATE "custom_profiles" SET "is_shared" = false WHERE "is_shared" = true AND "lifecycle_status" NOT IN ('pilot', 'verified');
