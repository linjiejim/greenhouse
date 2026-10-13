CREATE TABLE "auth_links" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_auth_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"delivery_status" text DEFAULT 'shown' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"group_id" text NOT NULL,
	"member_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_member_id_pk" PRIMARY KEY("group_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "members" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_file_id" text,
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'invited' NOT NULL,
	"password_hash" text,
	"auth_version" integer DEFAULT 0 NOT NULL,
	"locale" text DEFAULT 'zh' NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"theme" text DEFAULT 'system' NOT NULL,
	"about" text DEFAULT '' NOT NULL,
	"modules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"notification_settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pins" (
	"member_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pins_member_id_target_type_target_id_pk" PRIMARY KEY("member_id","target_type","target_id")
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"auth_version" integer NOT NULL,
	"client" text DEFAULT 'web' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal_id" text,
	"role" text NOT NULL,
	"custom_role_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_grant_key" UNIQUE NULLS NOT DISTINCT("resource_type","resource_id","principal_type","principal_id")
);
--> statement-breakpoint
CREATE TABLE "agent_computers" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"sandbox_ref" text NOT NULL,
	"state" text DEFAULT 'stopped' NOT NULL,
	"state_reason" text,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"last_active_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_memories" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"member_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"category" text DEFAULT 'fact' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"superseded_by" text,
	"source_conversation_id" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"version" integer NOT NULL,
	"manifest" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"change_note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"is_main" boolean DEFAULT false NOT NULL,
	"name" text NOT NULL,
	"name_key" text NOT NULL,
	"role" text DEFAULT '' NOT NULL,
	"avatar" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"current_version" integer DEFAULT 1 NOT NULL,
	"visibility" text DEFAULT 'private' NOT NULL,
	"published_version" integer,
	"paused_at" timestamp with time zone,
	"publication" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"template_key" text,
	"last_active_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "computer_watches" (
	"id" text PRIMARY KEY NOT NULL,
	"computer_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"member_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"job_ref" text NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'watching' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_agents" (
	"conversation_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_agents_conversation_id_agent_id_pk" PRIMARY KEY("conversation_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_inbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "conversation_inbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"conversation_id" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversation_members" (
	"conversation_id" text NOT NULL,
	"member_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"last_read_seq" integer DEFAULT 0 NOT NULL,
	"muted_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_members_conversation_id_member_id_pk" PRIMARY KEY("conversation_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"title" text DEFAULT '' NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"author_member_id" text,
	"author_agent_id" text,
	"status" text DEFAULT 'open' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"agent_id" text,
	"title" text DEFAULT '' NOT NULL,
	"model" text,
	"origin" text DEFAULT 'web' NOT NULL,
	"external_key" text,
	"context" jsonb,
	"read_only" boolean DEFAULT false NOT NULL,
	"forked_from_message_id" text,
	"digest" text DEFAULT '' NOT NULL,
	"digest_upto_seq" integer DEFAULT 0 NOT NULL,
	"last_seq" integer DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoffs" (
	"id" text PRIMARY KEY NOT NULL,
	"requested_by" text NOT NULL,
	"source_conversation_id" text NOT NULL,
	"source_agent_id" text NOT NULL,
	"target_conversation_id" text NOT NULL,
	"target_agent_id" text NOT NULL,
	"run_id" text,
	"chain_key" text NOT NULL,
	"path" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reply" text,
	"returned_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "message_feedback" (
	"message_id" text NOT NULL,
	"member_id" text NOT NULL,
	"rating" integer NOT NULL,
	"comment" text DEFAULT '' NOT NULL,
	"agent_id" text,
	"agent_version" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_feedback_message_id_member_id_pk" PRIMARY KEY("message_id","member_id")
);
--> statement-breakpoint
CREATE TABLE "message_receipts" (
	"message_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_receipts_message_id_agent_id_pk" PRIMARY KEY("message_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"author_member_id" text,
	"agent_id" text,
	"content" text DEFAULT '' NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quote" jsonb,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"skill" jsonb,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reasoning" text,
	"event" jsonb,
	"run_id" text,
	"status" text DEFAULT 'complete' NOT NULL,
	"edited_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "requests" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"conversation_id" text,
	"run_id" text,
	"step_id" text,
	"agent_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb,
	"expires_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "run_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"parent_step_id" text,
	"key" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"tool_name" text,
	"risk" text,
	"idempotency_key" text,
	"request_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error" jsonb,
	"tokens" jsonb,
	"duration_ms" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"requested_by" text,
	"kind" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text,
	"conversation_id" text,
	"parent_run_id" text,
	"root_run_id" text,
	"title" text DEFAULT '' NOT NULL,
	"brief" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"desired_state" text DEFAULT 'run' NOT NULL,
	"wait_reason" text,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"deadline_at" timestamp with time zone,
	"checkpoint" jsonb,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"version" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"provider_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"owner_id" text,
	"folder_id" text,
	"space" text,
	"conversation_id" text,
	"base_id" text,
	"run_id" text,
	"expires_at" timestamp with time zone,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_bindings" (
	"capability" text PRIMARY KEY NOT NULL,
	"instance_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"defaults" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "providers" (
	"id" text PRIMARY KEY NOT NULL,
	"capability" text NOT NULL,
	"kind" text NOT NULL,
	"preset" text,
	"name" text NOT NULL,
	"scope" text DEFAULT 'workspace' NOT NULL,
	"owner_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_check" jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"target_type" text,
	"target_id" text,
	"request_id" text,
	"run_id" text,
	"agent_id" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"brief" text NOT NULL,
	"skill_id" text,
	"model" text,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"next_run_at" timestamp with time zone,
	"last_run_at" timestamp with time zone,
	"last_run_id" text,
	"last_status" text,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "audit_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"actor_type" text NOT NULL,
	"actor_id" text,
	"on_behalf_of" text,
	"agent_id" text,
	"client_id" text,
	"request_id" text,
	"action" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"scope_type" text,
	"scope_id" text,
	"result" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_periods" (
	"budget_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"reserved" bigint DEFAULT 0 NOT NULL,
	"spent" bigint DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "budget_periods_budget_id_period_start_pk" PRIMARY KEY("budget_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"budget_id" text NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"estimated" bigint NOT NULL,
	"actual" bigint,
	"status" text DEFAULT 'reserved' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"member_id" text,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"unit" text NOT NULL,
	"monthly_limit" bigint NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "usage_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"capability" text NOT NULL,
	"provider_id" text NOT NULL,
	"source" text NOT NULL,
	"member_id" text,
	"agent_id" text,
	"run_id" text,
	"conversation_id" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"quantity" numeric,
	"unit" text,
	"cost_micros" bigint,
	"estimated" boolean DEFAULT false NOT NULL,
	"budget_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "idempotency_keys" (
	"scope" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"response" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_keys_scope_key_pk" PRIMARY KEY("scope","key")
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text DEFAULT 'Greenhouse' NOT NULL,
	"logo_file_id" text,
	"primary_color" text,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"setup_completed_at" timestamp with time zone,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_links" ADD CONSTRAINT "auth_links_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pins" ADD CONSTRAINT "pins_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_computers" ADD CONSTRAINT "agent_computers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_watches" ADD CONSTRAINT "computer_watches_computer_id_agent_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."agent_computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_agents" ADD CONSTRAINT "conversation_agents_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_agents" ADD CONSTRAINT "conversation_agents_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_inbox" ADD CONSTRAINT "conversation_inbox_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_notes" ADD CONSTRAINT "conversation_notes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoffs" ADD CONSTRAINT "handoffs_requested_by_members_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_feedback" ADD CONSTRAINT "message_feedback_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_receipts" ADD CONSTRAINT "message_receipts_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_member_id_members_id_fk" FOREIGN KEY ("author_member_id") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requests" ADD CONSTRAINT "requests_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_links_hash_key" ON "auth_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_links_live_key" ON "auth_links" USING btree ("member_id") WHERE "auth_links"."consumed_at" IS NULL AND "auth_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "group_members_member_idx" ON "group_members" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_key" ON "groups" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "members_email_key" ON "members" USING btree ("email");--> statement-breakpoint
CREATE INDEX "members_role_idx" ON "members" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_member_idx" ON "refresh_tokens" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "shares_principal_idx" ON "shares" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_computers_agent_key" ON "agent_computers" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_computers_state_idx" ON "agent_computers" USING btree ("state");--> statement-breakpoint
CREATE INDEX "agent_memories_agent_idx" ON "agent_memories" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_version_key" ON "agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_main_key" ON "agents" USING btree ("owner_id") WHERE "agents"."is_main";--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_name_key" ON "agents" USING btree ("owner_id","name_key") WHERE "agents"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agents_visibility_idx" ON "agents" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "computer_watches_job_key" ON "computer_watches" USING btree ("computer_id","job_ref");--> statement-breakpoint
CREATE INDEX "computer_watches_status_idx" ON "computer_watches" USING btree ("status");--> statement-breakpoint
CREATE INDEX "conversation_inbox_pending_idx" ON "conversation_inbox" USING btree ("conversation_id","id") WHERE "conversation_inbox"."consumed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_members_member_idx" ON "conversation_members" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "conversation_notes_conversation_idx" ON "conversation_notes" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_main_key" ON "conversations" USING btree ("owner_id") WHERE "conversations"."kind" = 'main';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_one_direct_key" ON "conversations" USING btree ("owner_id","agent_id") WHERE "conversations"."kind" = 'direct';--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_external_key" ON "conversations" USING btree ("external_key");--> statement-breakpoint
CREATE INDEX "conversations_owner_activity_idx" ON "conversations" USING btree ("owner_id","last_activity_at");--> statement-breakpoint
CREATE UNIQUE INDEX "handoffs_dedupe_key" ON "handoffs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "handoffs_chain_idx" ON "handoffs" USING btree ("chain_key");--> statement-breakpoint
CREATE INDEX "message_feedback_agent_idx" ON "message_feedback" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_seq_key" ON "messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "requests_member_status_idx" ON "requests" USING btree ("member_id","status");--> statement-breakpoint
CREATE INDEX "requests_conversation_idx" ON "requests" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_seq_key" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_attempt_key" ON "run_steps" USING btree ("run_id","key","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_idempotency_key" ON "run_steps" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "runs_owner_status_idx" ON "runs" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "runs_agent_idx" ON "runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_claimable_idx" ON "runs" USING btree ("status","lease_expires_at") WHERE "runs"."kind" = 'background';--> statement-breakpoint
CREATE INDEX "runs_conversation_idx" ON "runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_turn_key" ON "runs" USING btree ("conversation_id") WHERE "runs"."kind" = 'turn' AND "runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_conversation_idx" ON "files" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "files_folder_idx" ON "files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "files_run_idx" ON "files" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "providers_capability_idx" ON "providers" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "providers_owner_idx" ON "providers" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key" ON "notifications" USING btree ("member_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_member_idx" ON "notifications" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "schedules_agent_idx" ON "schedules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_key" ON "budget_reservations" USING btree ("budget_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_scope_key" ON "budgets" USING btree ("scope_type","scope_id","unit");--> statement-breakpoint
CREATE INDEX "usage_events_member_idx" ON "usage_events" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_provider_idx" ON "usage_events" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_claimable_idx" ON "jobs" USING btree ("available_at") WHERE "jobs"."status" = 'pending';