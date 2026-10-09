ALTER TABLE "mcp_servers" ADD COLUMN "auth_mode" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth_query_param" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "auth_value_prefix" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "credential_help" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "credential_url" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_scope" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_client_encrypted" text;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "oauth_discovery" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "read_only_tools" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "catalog_id" text;--> statement-breakpoint
ALTER TABLE "bot_versions" ADD COLUMN "connectors" text;--> statement-breakpoint
ALTER TABLE "bots" ADD COLUMN "connectors" text;--> statement-breakpoint
-- A server registered before auth modes existed sends its stored credential to everyone: that is "shared".
UPDATE "mcp_servers" SET "auth_mode" = 'shared' WHERE "auth_value_encrypted" IS NOT NULL;
