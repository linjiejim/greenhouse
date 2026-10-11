ALTER TABLE "llm_usage" ADD COLUMN "bot_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "platform_audit_events" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "vault_items" ADD COLUMN "bot_ids" text;--> statement-breakpoint
CREATE INDEX "idx_llm_usage_bot_created" ON "llm_usage" USING btree ("bot_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_platform_audit_agent_created" ON "platform_audit_events" USING btree ("agent_id","created_at");