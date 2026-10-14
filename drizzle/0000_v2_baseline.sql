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
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth_method" text DEFAULT 'none' NOT NULL,
	"secret_hash" text,
	"bound_member_id" text,
	"allowed_scopes" jsonb,
	"registration" text DEFAULT 'dynamic' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"token_hash" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
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
	"lease_controller" text,
	"lease_holder" text,
	"lease_until" timestamp with time zone,
	"background_run_id" text,
	"egress_restricted" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "standing_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"member_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
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
	"dedupe_key" text,
	"ready_at" timestamp with time zone DEFAULT now() NOT NULL,
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
	"rich_blocks" jsonb,
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
	"undo_state" jsonb,
	"undone_at" timestamp with time zone,
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
	"search_a" text DEFAULT '' NOT NULL,
	"search_b" text DEFAULT '' NOT NULL,
	"search_c" text DEFAULT '' NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', search_a), 'A') || setweight(to_tsvector('simple', search_b), 'B') || setweight(to_tsvector('simple', search_c), 'C')) STORED,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"bundle_file_id" text,
	"files" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_name" text DEFAULT '' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"space" text NOT NULL,
	"owner_id" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_version" text NOT NULL,
	"requirements" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"scan_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scanned_at" timestamp with time zone,
	"scan_reviewed_by" text,
	"scan_note" text,
	"download_count" integer DEFAULT 0 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"kind" text NOT NULL,
	"connector_id" text,
	"external_id" text,
	"display_name" text DEFAULT '' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secrets_enc" text,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"url" text NOT NULL,
	"transport" text DEFAULT 'streamable_http' NOT NULL,
	"auth_mode" text DEFAULT 'none' NOT NULL,
	"auth_header" text,
	"auth_query_param" text,
	"auth_prefix" text,
	"auth_enc" text,
	"key_help" text DEFAULT '' NOT NULL,
	"key_help_url" text,
	"oauth_scope" text,
	"oauth_client_enc" text,
	"oauth_discovery" jsonb,
	"allowed_tools" jsonb,
	"read_only_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"catalog_id" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_refreshed_at" timestamp with time zone,
	"last_error" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_mailboxes" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"local_part" text NOT NULL,
	"allow_members" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_messages" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"direction" text NOT NULL,
	"status" text NOT NULL,
	"screen_reason" text,
	"provider_id" text,
	"provider_message_id" text,
	"message_id" text,
	"in_reply_to" text,
	"references" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"from_address" text NOT NULL,
	"from_name" text,
	"to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cc" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reply_to" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"text" text DEFAULT '' NOT NULL,
	"html_file_id" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"auth" jsonb DEFAULT '{"spf":"unknown","dkim":"unknown","dmarc":"unknown"}'::jsonb NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"conversation_id" text,
	"run_id" text,
	"error" text,
	"woke_at" timestamp with time zone,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_senders" (
	"agent_id" text NOT NULL,
	"address" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mail_senders_agent_id_address_pk" PRIMARY KEY("agent_id","address")
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
CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"project_id" text NOT NULL,
	"client_ref" text,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_version" integer NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"owner_id" text NOT NULL,
	"name" text NOT NULL,
	"brief" text NOT NULL,
	"quiet" boolean DEFAULT false NOT NULL,
	"computer" boolean DEFAULT false NOT NULL,
	"domains" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"continue_after" boolean DEFAULT false NOT NULL,
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
CREATE TABLE "vault_access_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "vault_access_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"member_id" text NOT NULL,
	"item_id" text,
	"item_label" text NOT NULL,
	"agent_id" text,
	"conversation_id" text,
	"origin" text NOT NULL,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"approval" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_items" (
	"id" text PRIMARY KEY NOT NULL,
	"member_id" text NOT NULL,
	"label" text NOT NULL,
	"origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"username_enc" text,
	"password_enc" text,
	"totp_enc" text,
	"username_hint" text DEFAULT '' NOT NULL,
	"policy" text DEFAULT 'ask' NOT NULL,
	"always_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"agent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "comments" (
	"id" text PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"base_id" text,
	"created_by" text,
	"agent_id" text,
	"body" text NOT NULL,
	"mentions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "doc_links" (
	"from_doc_id" text NOT NULL,
	"to_doc_id" text NOT NULL,
	CONSTRAINT "doc_links_from_doc_id_to_doc_id_pk" PRIMARY KEY("from_doc_id","to_doc_id")
);
--> statement-breakpoint
CREATE TABLE "doc_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"change_note" text DEFAULT '' NOT NULL,
	"created_by" text,
	"agent_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docs" (
	"id" text PRIMARY KEY NOT NULL,
	"folder_id" text,
	"space" text NOT NULL,
	"owner_id" text,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"search_a" text DEFAULT '' NOT NULL,
	"search_b" text DEFAULT '' NOT NULL,
	"search_c" text DEFAULT '' NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', search_a), 'A') || setweight(to_tsvector('simple', search_b), 'B') || setweight(to_tsvector('simple', search_c), 'C')) STORED,
	"created_by" text,
	"updated_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "docs_owner_by_space" CHECK (("docs"."space" = 'personal') = ("docs"."owner_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"space" text NOT NULL,
	"owner_id" text,
	"agent_id" text,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "folders_owner_by_space" CHECK (("folders"."space" = 'personal') = ("folders"."owner_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "base_field_deps" (
	"field_id" text NOT NULL,
	"depends_on_field_id" text NOT NULL,
	"kind" text NOT NULL,
	CONSTRAINT "base_field_deps_field_id_depends_on_field_id_pk" PRIMARY KEY("field_id","depends_on_field_id")
);
--> statement-breakpoint
CREATE TABLE "base_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_form_submissions" (
	"id" text PRIMARY KEY NOT NULL,
	"form_id" text NOT NULL,
	"member_id" text NOT NULL,
	"record_id" text,
	"single_submit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_forms" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_imports" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"table_id" text NOT NULL,
	"member_id" text NOT NULL,
	"file_id" text,
	"mapping" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"total_rows" integer DEFAULT 0 NOT NULL,
	"committed_rows" integer DEFAULT 0 NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_record_events" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "base_record_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"record_id" text NOT NULL,
	"table_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"type" text NOT NULL,
	"changes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_record_files" (
	"record_id" text NOT NULL,
	"field_id" text NOT NULL,
	"file_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_record_files_record_id_field_id_file_id_pk" PRIMARY KEY("record_id","field_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "base_record_links" (
	"field_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"target_record_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_record_links_field_id_source_record_id_target_record_id_pk" PRIMARY KEY("field_id","source_record_id","target_record_id")
);
--> statement-breakpoint
CREATE TABLE "base_records" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "base_records_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"table_id" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"computed_revision" integer DEFAULT 0 NOT NULL,
	"search_a" text DEFAULT '' NOT NULL,
	"search_b" text DEFAULT '' NOT NULL,
	"search_c" text DEFAULT '' NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', search_a), 'A') || setweight(to_tsvector('simple', search_b), 'B') || setweight(to_tsvector('simple', search_c), 'C')) STORED,
	"created_by" text,
	"updated_by" text,
	"deleted_at" timestamp with time zone,
	"deleted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"schema_revision" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_views" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"table_id" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"owner_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT '' NOT NULL,
	"owner_id" text NOT NULL,
	"template_key" text,
	"template_version" text,
	"created_by" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"version" integer NOT NULL,
	"spec" text NOT NULL,
	"spec_hash" text NOT NULL,
	"draft_revision" integer NOT NULL,
	"notes" text DEFAULT '' NOT NULL,
	"published_by" text NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_versions_number_key" UNIQUE("app_id","version")
);
--> statement-breakpoint
CREATE TABLE "apps" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"icon" text DEFAULT 'layout-grid' NOT NULL,
	"accent" text DEFAULT 'green' NOT NULL,
	"owner_id" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"draft_spec" text NOT NULL,
	"draft_revision" integer DEFAULT 1 NOT NULL,
	"published_version" integer,
	"featured" boolean DEFAULT false NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_template_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"template_id" text NOT NULL,
	"version" text NOT NULL,
	"changelog" text DEFAULT '' NOT NULL,
	"content" text NOT NULL,
	"content_hash" text NOT NULL,
	"scan_status" text DEFAULT 'passed' NOT NULL,
	"review_status" text DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_template_versions_number_key" UNIQUE("template_id","version")
);
--> statement-breakpoint
CREATE TABLE "base_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"owner_id" text NOT NULL,
	"latest_version" text NOT NULL,
	"source_app_id" text,
	"source_base_id" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "base_templates_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "base_automation_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"automation_id" text NOT NULL,
	"record_id" text,
	"trigger" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"revision" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"steps" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"event_chain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"run_id" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "base_automations" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"trigger" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_as" text NOT NULL,
	"secrets_enc" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"next_fire_at" timestamp with time zone,
	"swept_until" timestamp with time zone,
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
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_bound_member_id_members_id_fk" FOREIGN KEY ("bound_member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_computers" ADD CONSTRAINT "agent_computers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memories" ADD CONSTRAINT "agent_memories_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "computer_watches" ADD CONSTRAINT "computer_watches_computer_id_agent_computers_id_fk" FOREIGN KEY ("computer_id") REFERENCES "public"."agent_computers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD CONSTRAINT "standing_approvals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "standing_approvals" ADD CONSTRAINT "standing_approvals_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
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
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connectors" ADD CONSTRAINT "connectors_created_by_members_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."members"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mailboxes" ADD CONSTRAINT "agent_mailboxes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_messages" ADD CONSTRAINT "mail_messages_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_senders" ADD CONSTRAINT "mail_senders_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "providers" ADD CONSTRAINT "providers_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_access_log" ADD CONSTRAINT "vault_access_log_item_id_vault_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."vault_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_links" ADD CONSTRAINT "doc_links_from_doc_id_docs_id_fk" FOREIGN KEY ("from_doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_links" ADD CONSTRAINT "doc_links_to_doc_id_docs_id_fk" FOREIGN KEY ("to_doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "doc_versions" ADD CONSTRAINT "doc_versions_doc_id_docs_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "docs" ADD CONSTRAINT "docs_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_field_deps" ADD CONSTRAINT "base_field_deps_field_id_base_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."base_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_field_deps" ADD CONSTRAINT "base_field_deps_depends_on_field_id_base_fields_id_fk" FOREIGN KEY ("depends_on_field_id") REFERENCES "public"."base_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_fields" ADD CONSTRAINT "base_fields_table_id_base_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."base_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_form_submissions" ADD CONSTRAINT "base_form_submissions_form_id_base_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."base_forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_form_submissions" ADD CONSTRAINT "base_form_submissions_record_id_base_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."base_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_forms" ADD CONSTRAINT "base_forms_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_forms" ADD CONSTRAINT "base_forms_table_id_base_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."base_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_imports" ADD CONSTRAINT "base_imports_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_imports" ADD CONSTRAINT "base_imports_table_id_base_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."base_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_imports" ADD CONSTRAINT "base_imports_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_record_events" ADD CONSTRAINT "base_record_events_record_id_base_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."base_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_record_files" ADD CONSTRAINT "base_record_files_record_id_base_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."base_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_record_files" ADD CONSTRAINT "base_record_files_field_id_base_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."base_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_record_files" ADD CONSTRAINT "base_record_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_record_links" ADD CONSTRAINT "base_record_links_field_id_base_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."base_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_record_links" ADD CONSTRAINT "base_record_links_source_record_id_base_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."base_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_record_links" ADD CONSTRAINT "base_record_links_target_record_id_base_records_id_fk" FOREIGN KEY ("target_record_id") REFERENCES "public"."base_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_records" ADD CONSTRAINT "base_records_table_id_base_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."base_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_roles" ADD CONSTRAINT "base_roles_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_tables" ADD CONSTRAINT "base_tables_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_views" ADD CONSTRAINT "base_views_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_views" ADD CONSTRAINT "base_views_table_id_base_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."base_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_views" ADD CONSTRAINT "base_views_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bases" ADD CONSTRAINT "bases_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_versions" ADD CONSTRAINT "app_versions_app_id_apps_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."apps"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "apps" ADD CONSTRAINT "apps_owner_id_members_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."members"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_template_versions" ADD CONSTRAINT "base_template_versions_template_id_base_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."base_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_automation_runs" ADD CONSTRAINT "base_automation_runs_automation_id_base_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."base_automations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_automations" ADD CONSTRAINT "base_automations_base_id_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "base_automations" ADD CONSTRAINT "base_automations_table_id_base_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."base_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_links_hash_key" ON "auth_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_links_live_key" ON "auth_links" USING btree ("member_id") WHERE "auth_links"."consumed_at" IS NULL AND "auth_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "group_members_member_idx" ON "group_members" USING btree ("member_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_name_key" ON "groups" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "members_email_key" ON "members" USING btree ("email");--> statement-breakpoint
CREATE INDEX "members_role_idx" ON "members" USING btree ("role");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_key" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_member_idx" ON "refresh_tokens" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "shares_principal_idx" ON "shares" USING btree ("principal_type","principal_id");--> statement-breakpoint
CREATE INDEX "oauth_clients_bound_member_idx" ON "oauth_clients" USING btree ("bound_member_id");--> statement-breakpoint
CREATE INDEX "oauth_codes_grant_idx" ON "oauth_codes" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_grants_member_client_key" ON "oauth_grants" USING btree ("member_id","client_id","resource");--> statement-breakpoint
CREATE INDEX "oauth_grants_client_idx" ON "oauth_grants" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_hash_key" ON "oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_tokens_grant_idx" ON "oauth_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_computers_agent_key" ON "agent_computers" USING btree ("agent_id","owner_id");--> statement-breakpoint
CREATE INDEX "agent_computers_state_idx" ON "agent_computers" USING btree ("state");--> statement-breakpoint
CREATE INDEX "agent_memories_agent_idx" ON "agent_memories" USING btree ("agent_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_versions_version_key" ON "agent_versions" USING btree ("agent_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "agents_one_main_key" ON "agents" USING btree ("owner_id") WHERE "agents"."is_main";--> statement-breakpoint
CREATE UNIQUE INDEX "agents_owner_name_key" ON "agents" USING btree ("owner_id","name_key") WHERE "agents"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "agents_owner_idx" ON "agents" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agents_visibility_idx" ON "agents" USING btree ("visibility");--> statement-breakpoint
CREATE UNIQUE INDEX "computer_watches_job_key" ON "computer_watches" USING btree ("computer_id","job_ref");--> statement-breakpoint
CREATE INDEX "computer_watches_status_idx" ON "computer_watches" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "standing_approvals_active_key" ON "standing_approvals" USING btree ("agent_id","member_id","scope_type","scope_id") WHERE "standing_approvals"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "conversation_inbox_pending_idx" ON "conversation_inbox" USING btree ("conversation_id","id") WHERE "conversation_inbox"."consumed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_inbox_dedupe_key" ON "conversation_inbox" USING btree ("conversation_id","dedupe_key");--> statement-breakpoint
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
CREATE INDEX "messages_run_idx" ON "messages" USING btree ("run_id") WHERE "messages"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_skill_runs_idx" ON "messages" USING btree ("author_member_id") WHERE "messages"."skill" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "requests_member_status_idx" ON "requests" USING btree ("member_id","status");--> statement-breakpoint
CREATE INDEX "requests_conversation_idx" ON "requests" USING btree ("conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "run_events_seq_key" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_attempt_key" ON "run_steps" USING btree ("run_id","key","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "run_steps_idempotency_key" ON "run_steps" USING btree ("run_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "runs_owner_status_idx" ON "runs" USING btree ("owner_id","status");--> statement-breakpoint
CREATE INDEX "runs_agent_idx" ON "runs" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_claimable_idx" ON "runs" USING btree ("status","lease_expires_at") WHERE "runs"."kind" = 'background';--> statement-breakpoint
CREATE INDEX "runs_conversation_idx" ON "runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "runs_turns_finished_idx" ON "runs" USING btree ("finished_at") WHERE "runs"."kind" = 'turn' AND "runs"."status" = 'succeeded';--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_turn_key" ON "runs" USING btree ("conversation_id") WHERE "runs"."kind" = 'turn' AND "runs"."status" IN ('queued', 'running');--> statement-breakpoint
CREATE UNIQUE INDEX "files_storage_key" ON "files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "files_conversation_idx" ON "files" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "files_folder_idx" ON "files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "files_run_idx" ON "files" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "files_search_idx" ON "files" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_versions_version_key" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "skill_versions_bundle_idx" ON "skill_versions" USING btree ("bundle_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_team_name_key" ON "skills" USING btree ("name") WHERE "skills"."space" = 'team';--> statement-breakpoint
CREATE UNIQUE INDEX "skills_personal_name_key" ON "skills" USING btree ("owner_id","name") WHERE "skills"."space" = 'personal';--> statement-breakpoint
CREATE INDEX "skills_owner_idx" ON "skills" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_member_connector_key" ON "connections" USING btree ("member_id","connector_id") WHERE "connections"."kind" = 'connector';--> statement-breakpoint
CREATE UNIQUE INDEX "connections_member_email_key" ON "connections" USING btree ("member_id") WHERE "connections"."kind" = 'email';--> statement-breakpoint
CREATE UNIQUE INDEX "connections_external_key" ON "connections" USING btree ("kind","external_id") WHERE "connections"."kind" IN ('feishu', 'wecom');--> statement-breakpoint
CREATE INDEX "connections_member_idx" ON "connections" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "connections_connector_idx" ON "connections" USING btree ("connector_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connectors_slug_key" ON "connectors" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_mailboxes_agent_key" ON "agent_mailboxes" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_mailboxes_local_part_key" ON "agent_mailboxes" USING btree ("local_part");--> statement-breakpoint
CREATE UNIQUE INDEX "mail_messages_received_key" ON "mail_messages" USING btree ("agent_id","provider_id","provider_message_id") WHERE "mail_messages"."direction" = 'in';--> statement-breakpoint
CREATE INDEX "mail_messages_agent_idx" ON "mail_messages" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "mail_messages_agent_status_idx" ON "mail_messages" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "providers_capability_idx" ON "providers" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "providers_owner_idx" ON "providers" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notifications_dedupe_key" ON "notifications" USING btree ("member_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "notifications_member_idx" ON "notifications" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "push_devices_token_key" ON "push_devices" USING btree ("token");--> statement-breakpoint
CREATE INDEX "push_devices_member_active_idx" ON "push_devices" USING btree ("member_id") WHERE "push_devices"."disabled_at" IS NULL;--> statement-breakpoint
CREATE INDEX "schedules_due_idx" ON "schedules" USING btree ("status","next_run_at");--> statement-breakpoint
CREATE INDEX "schedules_agent_idx" ON "schedules" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_resource_idx" ON "audit_events" USING btree ("resource_type","resource_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_reservations_key" ON "budget_reservations" USING btree ("budget_id","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "budgets_scope_key" ON "budgets" USING btree ("scope_type","scope_id","unit");--> statement-breakpoint
CREATE INDEX "usage_events_member_idx" ON "usage_events" USING btree ("member_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_provider_idx" ON "usage_events" USING btree ("provider_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_agent_idx" ON "usage_events" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_time_idx" ON "usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_claimable_idx" ON "jobs" USING btree ("available_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "vault_access_log_member_idx" ON "vault_access_log" USING btree ("member_id","id");--> statement-breakpoint
CREATE INDEX "vault_items_member_idx" ON "vault_items" USING btree ("member_id");--> statement-breakpoint
CREATE INDEX "comments_target_idx" ON "comments" USING btree ("target_type","target_id","id");--> statement-breakpoint
CREATE INDEX "doc_links_to_idx" ON "doc_links" USING btree ("to_doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "doc_versions_version_key" ON "doc_versions" USING btree ("doc_id","version");--> statement-breakpoint
CREATE INDEX "docs_folder_idx" ON "docs" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "docs_owner_idx" ON "docs" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "docs_updated_idx" ON "docs" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "docs_search_idx" ON "docs" USING gin ("search_tsv");--> statement-breakpoint
CREATE INDEX "folders_parent_idx" ON "folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "folders_owner_idx" ON "folders" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "folders_agent_key" ON "folders" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "base_field_deps_source_idx" ON "base_field_deps" USING btree ("depends_on_field_id");--> statement-breakpoint
CREATE INDEX "base_fields_table_idx" ON "base_fields" USING btree ("table_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "base_fields_name_key" ON "base_fields" USING btree ("table_id","name") WHERE "base_fields"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "base_fields_primary_key" ON "base_fields" USING btree ("table_id") WHERE "base_fields"."is_primary";--> statement-breakpoint
CREATE INDEX "base_form_submissions_form_idx" ON "base_form_submissions" USING btree ("form_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "base_form_submissions_single_key" ON "base_form_submissions" USING btree ("form_id","member_id") WHERE "base_form_submissions"."single_submit";--> statement-breakpoint
CREATE INDEX "base_forms_table_idx" ON "base_forms" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "base_forms_base_idx" ON "base_forms" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "base_imports_table_idx" ON "base_imports" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE INDEX "base_record_events_record_idx" ON "base_record_events" USING btree ("record_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "base_record_files_file_key" ON "base_record_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "base_record_links_source_idx" ON "base_record_links" USING btree ("source_record_id");--> statement-breakpoint
CREATE INDEX "base_record_links_target_idx" ON "base_record_links" USING btree ("target_record_id");--> statement-breakpoint
CREATE INDEX "base_records_table_idx" ON "base_records" USING btree ("table_id","seq") WHERE "base_records"."deleted_at" IS NULL;--> statement-breakpoint
CREATE INDEX "base_records_trash_idx" ON "base_records" USING btree ("table_id","deleted_at") WHERE "base_records"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "base_records_search_idx" ON "base_records" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "base_roles_name_key" ON "base_roles" USING btree ("base_id","name");--> statement-breakpoint
CREATE INDEX "base_tables_base_idx" ON "base_tables" USING btree ("base_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "base_tables_name_key" ON "base_tables" USING btree ("base_id","name") WHERE "base_tables"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "base_views_table_idx" ON "base_views" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "base_views_base_idx" ON "base_views" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "bases_owner_idx" ON "bases" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "apps_base_idx" ON "apps" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "apps_owner_idx" ON "apps" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "base_templates_owner_idx" ON "base_templates" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "base_automation_runs_dedupe_key" ON "base_automation_runs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "base_automation_runs_automation_idx" ON "base_automation_runs" USING btree ("automation_id","id");--> statement-breakpoint
CREATE INDEX "base_automations_table_idx" ON "base_automations" USING btree ("table_id");--> statement-breakpoint
CREATE INDEX "base_automations_due_idx" ON "base_automations" USING btree ("status","next_fire_at");