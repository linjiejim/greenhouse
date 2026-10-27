CREATE TABLE "mcp_connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"owner_user_id" text,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"url" text NOT NULL,
	"transport" text DEFAULT 'streamable_http' NOT NULL,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"auth_kind" text,
	"auth_header" text,
	"auth_query_param" text,
	"auth_value_prefix" text,
	"shared_secret_enc" text,
	"oauth_client_enc" text,
	"oauth_discovery" jsonb,
	"oauth_scope" text,
	"private_network" boolean DEFAULT false NOT NULL,
	"allow_external_writes" boolean DEFAULT false NOT NULL,
	"tool_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"vouched_read_only" text[] DEFAULT '{}'::text[] NOT NULL,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_refreshed_at" timestamp with time zone,
	"last_error" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"catalog_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_mcp_connectors_scope_owner_slug" UNIQUE NULLS NOT DISTINCT("scope","owner_user_id","slug"),
	CONSTRAINT "chk_mcp_connectors_scope" CHECK ("mcp_connectors"."scope" IN ('team', 'personal')),
	CONSTRAINT "chk_mcp_connectors_transport" CHECK ("mcp_connectors"."transport" IN ('streamable_http', 'sse')),
	CONSTRAINT "chk_mcp_connectors_auth_mode" CHECK ("mcp_connectors"."auth_mode" IN ('none', 'shared', 'per_member')),
	CONSTRAINT "chk_mcp_connectors_auth_kind" CHECK ("mcp_connectors"."auth_kind" IN ('key', 'oauth')),
	CONSTRAINT "chk_mcp_connectors_owner" CHECK (("mcp_connectors"."scope" = 'personal' AND "mcp_connectors"."owner_user_id" IS NOT NULL) OR ("mcp_connectors"."scope" = 'team' AND "mcp_connectors"."owner_user_id" IS NULL)),
	CONSTRAINT "chk_mcp_connectors_personal" CHECK ("mcp_connectors"."scope" = 'team' OR ("mcp_connectors"."auth_mode" IN ('none', 'per_member') AND "mcp_connectors"."private_network" = false))
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "chk_runs_kind";--> statement-breakpoint
ALTER TABLE "run_profiles" ADD COLUMN "connectors" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_connectors" ADD CONSTRAINT "mcp_connectors_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_connectors_owner" ON "mcp_connectors" USING btree ("owner_user_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "chk_runs_kind" CHECK ("runs"."kind" IN ('chat', 'automation', 'workflow', 'mission', 'subagent', 'eval', 'agent_write', 'connector_write'));