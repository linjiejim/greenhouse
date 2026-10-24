CREATE TABLE "auth_refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"auth_version" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_states" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_login_states_kind" CHECK ("login_states"."kind" IN ('pending', 'login_code'))
);
--> statement-breakpoint
CREATE TABLE "password_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_auth_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"delivery_error" text,
	CONSTRAINT "chk_password_links_purpose" CHECK ("password_links"."purpose" IN ('invite', 'reset')),
	CONSTRAINT "chk_password_links_delivery" CHECK ("password_links"."delivery_status" IN ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"auth_version" integer DEFAULT 0 NOT NULL,
	"nickname" text NOT NULL,
	"role" text DEFAULT 'team' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "chk_users_role" CHECK ("users"."role" IN ('super', 'team', 'external')),
	CONSTRAINT "chk_users_status" CHECK ("users"."status" IN ('invited', 'active', 'reset_required', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "role_capabilities" (
	"role_id" text NOT NULL,
	"capability" text NOT NULL,
	"assigned_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_capabilities_role_id_capability_pk" PRIMARY KEY("role_id","capability")
);
--> statement-breakpoint
CREATE TABLE "role_entity_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"app_id" text NOT NULL,
	"module_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"field_policies" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_members" (
	"role_id" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_members_role_id_user_id_pk" PRIMARY KEY("role_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"system_protected" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_roles_status" CHECK ("roles"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "user_grants" (
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_grants_user_id_kind_key_pk" PRIMARY KEY("user_id","kind","key"),
	CONSTRAINT "chk_user_grants_kind" CHECK ("user_grants"."kind" IN ('feature', 'tool'))
);
--> statement-breakpoint
CREATE TABLE "gateway_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"allowed_models" jsonb,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"client_secret_hash" text,
	"bound_user_id" text,
	"allowed_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_oauth_clients_auth_method" CHECK ("oauth_clients"."token_endpoint_auth_method" IN ('none', 'client_secret_post')),
	CONSTRAINT "chk_oauth_clients_status" CHECK ("oauth_clients"."status" IN ('active', 'disabled'))
);
--> statement-breakpoint
CREATE TABLE "oauth_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_oauth_codes_method" CHECK ("oauth_codes"."code_challenge_method" IN ('S256'))
);
--> statement-breakpoint
CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"avatar" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "chk_oauth_grants_status" CHECK ("oauth_grants"."status" IN ('active', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_type" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_oauth_tokens_type" CHECK ("oauth_tokens"."token_type" IN ('access', 'refresh'))
);
--> statement-breakpoint
CREATE TABLE "provider_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"workspace_id" text,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"credential_enc" text,
	"token_type" text DEFAULT 'Bearer' NOT NULL,
	"scope" text,
	"expires_at" timestamp with time zone,
	"provider_user_id" text,
	"provider_email" text,
	"provider_name" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_provider_connections_user_workspace" UNIQUE NULLS NOT DISTINCT("user_id","provider","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "card_action_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_card_action_receipts_kind" CHECK ("card_action_receipts"."kind" IN ('tables_schema_plan', 'task_capture')),
	CONSTRAINT "chk_card_action_receipts_status" CHECK ("card_action_receipts"."status" IN ('processing', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "conversation_share_reads" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"read_at" timestamp with time zone,
	"pinned_at" timestamp with time zone,
	"pin_position" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "uq_conversation_share_reads_session_user" UNIQUE("session_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "conversation_shares" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"shared_with" text NOT NULL,
	"shared_by" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_conversation_shares_session_user" UNIQUE("session_id","shared_with")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"profile_id" text DEFAULT 'team' NOT NULL,
	"user_id" text,
	"app_id" text,
	"channel" text DEFAULT 'web' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"pinned_at" timestamp with time zone,
	"pin_position" integer DEFAULT 0 NOT NULL,
	"digest" text,
	"digest_upto_seq" integer,
	"digest_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"parts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reasoning" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"duration_ms" integer,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_user_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_run_events_seq" CHECK ("run_events"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "run_interrupts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"tool_call_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"canonical_input_hash" text,
	"risk_level" text,
	"assignee_user_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"decision" jsonb,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_run_interrupts_kind" CHECK ("run_interrupts"."kind" IN ('mutation_approval', 'workflow_gate', 'ask_user', 'credential_required', 'budget_exceeded', 'external_dependency', 'outcome_unknown', 'manual_pause')),
	CONSTRAINT "chk_run_interrupts_status" CHECK ("run_interrupts"."status" IN ('pending', 'resolved', 'rejected', 'expired', 'canceled')),
	CONSTRAINT "chk_run_interrupts_version" CHECK ("run_interrupts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "run_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_run_outbox_status" CHECK ("run_outbox"."status" IN ('pending', 'claimed', 'delivered', 'failed', 'dead_letter')),
	CONSTRAINT "chk_run_outbox_attempts" CHECK ("run_outbox"."attempts" >= 0 AND "run_outbox"."max_attempts" > 0),
	CONSTRAINT "chk_run_outbox_version" CHECK ("run_outbox"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"parent_step_id" text,
	"step_key" text NOT NULL,
	"kind" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"tokens_used" bigint DEFAULT 0 NOT NULL,
	"requests_used" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_run_steps_status" CHECK ("run_steps"."status" IN ('queued', 'claimed', 'running', 'waiting', 'paused', 'succeeded', 'failed', 'canceled', 'interrupted', 'skipped')),
	CONSTRAINT "chk_run_steps_attempt" CHECK ("run_steps"."attempt" > 0),
	CONSTRAINT "chk_run_steps_usage" CHECK ("run_steps"."tokens_used" >= 0 AND "run_steps"."requests_used" >= 0 AND "run_steps"."cost_micros" >= 0 AND ("run_steps"."duration_ms" IS NULL OR "run_steps"."duration_ms" >= 0)),
	CONSTRAINT "chk_run_steps_version" CHECK ("run_steps"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "run_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"tool_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"canonical_input_hash" text NOT NULL,
	"risk_level" text NOT NULL,
	"idempotency_key" text,
	"interrupt_id" text,
	"platform_audit_event_id" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_run_tool_calls_status" CHECK ("run_tool_calls"."status" IN ('pending', 'awaiting_approval', 'running', 'succeeded', 'failed', 'canceled', 'uncertain')),
	CONSTRAINT "chk_run_tool_calls_risk" CHECK ("run_tool_calls"."risk_level" IN ('r0', 'r1', 'r2', 'r3')),
	CONSTRAINT "chk_run_tool_calls_version" CHECK ("run_tool_calls"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"initiated_by_user_id" text NOT NULL,
	"session_id" text,
	"parent_run_id" text,
	"root_run_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"idempotency_key" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"desired_state" text DEFAULT 'run' NOT NULL,
	"wait_reason" text,
	"priority" integer DEFAULT 0 NOT NULL,
	"not_before" timestamp with time zone,
	"deadline_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_runs_kind" CHECK ("runs"."kind" IN ('chat', 'automation', 'workflow', 'mission', 'subagent', 'eval', 'agent_write')),
	CONSTRAINT "chk_runs_status" CHECK ("runs"."status" IN ('queued', 'claimed', 'running', 'waiting', 'paused', 'succeeded', 'failed', 'canceled', 'interrupted')),
	CONSTRAINT "chk_runs_desired_state" CHECK ("runs"."desired_state" IN ('run', 'pause', 'cancel')),
	CONSTRAINT "chk_runs_attempts" CHECK ("runs"."attempt" >= 0 AND "runs"."max_attempts" > 0),
	CONSTRAINT "chk_runs_version" CHECK ("runs"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "automation_occurrences" (
	"runtime_run_id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"status" text NOT NULL,
	"runtime_version" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"run_created_at" timestamp with time zone NOT NULL,
	"projected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_automation_occurrences_status" CHECK ("automation_occurrences"."status" IN ('succeeded', 'failed', 'canceled', 'interrupted'))
);
--> statement-breakpoint
CREATE TABLE "automations" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"profile_id" text DEFAULT 'team' NOT NULL,
	"task_prompt" text NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_steps" integer DEFAULT 15 NOT NULL,
	"notify" jsonb DEFAULT '{"webhook":null,"email":false,"wecom":false,"feishu":false}'::jsonb NOT NULL,
	"quiet_when_empty" boolean DEFAULT false NOT NULL,
	"unattended_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"next_run_at" timestamp with time zone,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "run_profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_profile_id" text DEFAULT 'team' NOT NULL,
	"model_id" text,
	"tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system_prompt" text NOT NULL,
	"max_steps" integer DEFAULT 12 NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"avatar" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"purpose" text,
	"audience" text,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"budget_policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"owner_backup_user_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_run_profiles_user_slug" UNIQUE("user_id","slug"),
	CONSTRAINT "chk_run_profiles_risk" CHECK ("run_profiles"."risk_level" IN ('low', 'medium', 'high'))
);
--> statement-breakpoint
CREATE TABLE "kb_documents" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"scope" text DEFAULT 'shared' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"content_hash" text,
	"visibility" text DEFAULT 'team' NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"is_template" boolean DEFAULT false NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"file_path" text,
	"folder_id" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"owner_user_id" text,
	"created_by" text,
	"updated_by" text,
	"_summary" text DEFAULT '' NOT NULL,
	"_questions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"_topics" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"_enriched_at" timestamp with time zone,
	"search_a" text DEFAULT '' NOT NULL,
	"search_b" text DEFAULT '' NOT NULL,
	"search_c" text DEFAULT '' NOT NULL,
	"search_tsv" "tsvector" GENERATED ALWAYS AS (setweight(to_tsvector('simple', search_a), 'A') || setweight(to_tsvector('simple', search_b), 'B') || setweight(to_tsvector('simple', search_c), 'C')) STORED,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_kb_documents_visibility" CHECK ("kb_documents"."visibility" IN ('team', 'private')),
	CONSTRAINT "chk_kb_documents_status" CHECK ("kb_documents"."status" IN ('draft', 'published', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "kb_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"changed_by" text,
	"change_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_links" (
	"file_id" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"slot" text DEFAULT '' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_links_file_id_target_type_target_id_slot_pk" PRIMARY KEY("file_id","target_type","target_id","slot"),
	CONSTRAINT "chk_file_links_target" CHECK ("file_links"."target_type" IN ('table_record', 'message', 'task', 'kb_document'))
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text,
	"size" bigint DEFAULT 0 NOT NULL,
	"sha256" text,
	"storage_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"scope" text,
	"folder_id" text,
	"visibility" text,
	"owner_user_id" text,
	"base_id" text,
	"owner_key" text,
	"session_id" text,
	"run_id" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_files_source" CHECK ("files"."source" IN ('drive', 'chat_upload', 'chat_output', 'run')),
	CONSTRAINT "chk_files_status" CHECK ("files"."status" IN ('pending', 'active', 'failed', 'skipped', 'deleted')),
	CONSTRAINT "chk_files_visibility" CHECK ("files"."visibility" IN ('team', 'private')),
	CONSTRAINT "chk_files_size" CHECK ("files"."size" >= 0),
	CONSTRAINT "chk_files_source_owner" CHECK ((
        ("files"."source" = 'drive' AND "files"."scope" IS NOT NULL AND "files"."storage_key" IS NOT NULL AND "files"."session_id" IS NULL AND "files"."run_id" IS NULL AND (
          ("files"."scope" = 'kb' AND "files"."base_id" IS NULL AND "files"."owner_key" IS NULL AND "files"."visibility" IS NOT NULL AND ("files"."visibility" = 'team' OR "files"."owner_user_id" IS NOT NULL))
          OR ("files"."scope" = 'tables' AND "files"."base_id" IS NOT NULL AND "files"."owner_key" IS NULL AND "files"."visibility" IS NULL AND "files"."owner_user_id" IS NULL)
          OR ("files"."scope" NOT IN ('kb', 'tables') AND "files"."owner_key" IS NOT NULL AND "files"."base_id" IS NULL AND "files"."visibility" IS NULL AND "files"."owner_user_id" IS NULL)
        ))
        OR ("files"."source" IN ('chat_upload', 'chat_output') AND "files"."session_id" IS NOT NULL AND "files"."storage_key" IS NOT NULL AND "files"."scope" IS NULL AND "files"."folder_id" IS NULL)
        OR ("files"."source" = 'run' AND "files"."run_id" IS NOT NULL AND "files"."scope" IS NULL AND "files"."folder_id" IS NULL AND "files"."session_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "folders" (
	"id" text PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"visibility" text,
	"owner_user_id" text,
	"base_id" text,
	"owner_key" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_folders_visibility" CHECK ("folders"."visibility" IN ('team', 'private')),
	CONSTRAINT "chk_folders_scope_owner" CHECK ((
        ("folders"."scope" = 'kb' AND "folders"."base_id" IS NULL AND "folders"."owner_key" IS NULL AND "folders"."visibility" IS NOT NULL AND ("folders"."visibility" = 'team' OR "folders"."owner_user_id" IS NOT NULL))
        OR ("folders"."scope" = 'tables' AND "folders"."base_id" IS NOT NULL AND "folders"."owner_key" IS NULL AND "folders"."visibility" IS NULL AND "folders"."owner_user_id" IS NULL)
        OR ("folders"."scope" NOT IN ('kb', 'tables') AND "folders"."owner_key" IS NOT NULL AND "folders"."base_id" IS NULL AND "folders"."visibility" IS NULL AND "folders"."owner_user_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" text PRIMARY KEY NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text NOT NULL,
	"principal_type" text DEFAULT 'user' NOT NULL,
	"principal_id" text,
	"role" text NOT NULL,
	"message" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_shares_grant" UNIQUE NULLS NOT DISTINCT("resource_type","resource_id","principal_type","principal_id"),
	CONSTRAINT "chk_shares_resource" CHECK ("shares"."resource_type" IN ('kb_document', 'folder', 'file', 'table_base')),
	CONSTRAINT "chk_shares_principal" CHECK ("shares"."principal_type" IN ('user', 'team')),
	CONSTRAINT "chk_shares_role" CHECK ("shares"."role" IN ('reader', 'editor', 'viewer', 'builder', 'owner')),
	CONSTRAINT "chk_shares_principal_id" CHECK (("shares"."principal_type" = 'team') = ("shares"."principal_id" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_project_members_role" CHECK ("project_members"."role" IN ('owner', 'member'))
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"owner_id" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"color" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_projects_status" CHECK ("projects"."status" IN ('planning', 'active', 'on_hold', 'completed', 'archived')),
	CONSTRAINT "chk_projects_priority" CHECK ("projects"."priority" IN ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "chk_projects_visibility" CHECK ("projects"."visibility" IN ('public', 'private'))
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"parent_id" text,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"task_type" text DEFAULT 'task' NOT NULL,
	"assignee_id" text,
	"start_date" date,
	"due_date" date,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"estimated_hours" integer,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dependencies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_tasks_status" CHECK ("tasks"."status" IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
	CONSTRAINT "chk_tasks_priority" CHECK ("tasks"."priority" IN ('low', 'normal', 'high', 'urgent'))
);
--> statement-breakpoint
CREATE TABLE "table_bases" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "chk_table_bases_visibility" CHECK ("table_bases"."visibility" IN ('private', 'team'))
);
--> statement-breakpoint
CREATE TABLE "table_field_dependencies" (
	"field_id" text NOT NULL,
	"depends_on_field_id" text NOT NULL,
	"dependency_type" text NOT NULL,
	CONSTRAINT "table_field_dependencies_field_id_depends_on_field_id_pk" PRIMARY KEY("field_id","depends_on_field_id"),
	CONSTRAINT "chk_table_field_dependencies_type" CHECK ("table_field_dependencies"."dependency_type" IN ('formula', 'lookup', 'rollup'))
);
--> statement-breakpoint
CREATE TABLE "table_fields" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "chk_table_fields_type" CHECK ("table_fields"."type" IN ('text', 'long_text', 'number', 'boolean', 'date', 'datetime', 'single_select', 'multi_select', 'user', 'multi_user', 'url', 'email', 'phone', 'attachment', 'relation', 'formula', 'rollup'))
);
--> statement-breakpoint
CREATE TABLE "table_recompute_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"field_id" text,
	"record_id" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "chk_table_recompute_jobs_status" CHECK ("table_recompute_jobs"."status" IN ('queued', 'running', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "table_record_links" (
	"id" text PRIMARY KEY NOT NULL,
	"field_id" text NOT NULL,
	"source_record_id" text NOT NULL,
	"target_record_id" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_records" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_revision" integer DEFAULT 1 NOT NULL,
	"computed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_schema_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"version" integer NOT NULL,
	"schema_snapshot" jsonb NOT NULL,
	"change_type" text NOT NULL,
	"changed_by" text NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_table_schema_versions_change" CHECK ("table_schema_versions"."change_type" IN ('created', 'field_created', 'field_updated', 'field_archived'))
);
--> statement-breakpoint
CREATE TABLE "table_tables" (
	"id" text PRIMARY KEY NOT NULL,
	"base_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"schema_revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_views" (
	"id" text PRIMARY KEY NOT NULL,
	"table_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'grid' NOT NULL,
	"scope" text DEFAULT 'shared' NOT NULL,
	"owner_id" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_table_views_type" CHECK ("table_views"."type" IN ('grid')),
	CONSTRAINT "chk_table_views_scope" CHECK ("table_views"."scope" IN ('shared', 'personal'))
);
--> statement-breakpoint
CREATE TABLE "notification_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"notification_id" text NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_notification_deliveries_channel" CHECK ("notification_deliveries"."channel" IN ('desktop', 'wecom', 'feishu', 'email', 'mobile_push')),
	CONSTRAINT "chk_notification_deliveries_status" CHECK ("notification_deliveries"."status" IN ('pending', 'claimed', 'delivered', 'failed', 'dead_letter', 'suppressed')),
	CONSTRAINT "chk_notification_deliveries_attempts" CHECK ("notification_deliveries"."attempts" >= 0 AND "notification_deliveries"."max_attempts" > 0 AND "notification_deliveries"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_id" text,
	"interrupt_id" text,
	"event_id" text,
	"agent_id" text,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_notifications_kind" CHECK ("notifications"."kind" IN ('runtime_attention', 'runtime_completed', 'runtime_failed', 'agent_review_due', 'agent_suspended', 'budget_attention', 'system'))
);
--> statement-breakpoint
CREATE TABLE "push_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"platform" text NOT NULL,
	"project_id" text NOT NULL,
	"client_ref" text,
	"prefs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_version" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"disabled_at" timestamp with time zone,
	"disabled_reason" text,
	CONSTRAINT "chk_push_devices_platform" CHECK ("push_devices"."platform" IN ('ios', 'android')),
	CONSTRAINT "chk_push_devices_disabled_reason" CHECK ("push_devices"."disabled_reason" IN ('unregistered', 'device_not_registered', 'device_limit'))
);
--> statement-breakpoint
CREATE TABLE "budget_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"reservation_id" text,
	"operation_key" text NOT NULL,
	"entry_type" text NOT NULL,
	"delta_reserved_units" bigint DEFAULT 0 NOT NULL,
	"delta_spent_units" bigint DEFAULT 0 NOT NULL,
	"reserved_units_after" bigint NOT NULL,
	"spent_units_after" bigint NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_budget_ledger_entry_type" CHECK ("budget_ledger"."entry_type" IN ('bootstrap', 'reconcile', 'reserve', 'settle', 'release', 'expire', 'adjustment', 'status')),
	CONSTRAINT "chk_budget_ledger_balances" CHECK ("budget_ledger"."reserved_units_after" >= 0 AND "budget_ledger"."spent_units_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'reserved' NOT NULL,
	"estimated_units" bigint NOT NULL,
	"actual_units" bigint,
	"caller" text NOT NULL,
	"user_id" text,
	"run_id" text,
	"provider_id" text,
	"model_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_budget_reservations_status" CHECK ("budget_reservations"."status" IN ('reserved', 'settled', 'released', 'expired')),
	CONSTRAINT "chk_budget_reservations_estimate" CHECK ("budget_reservations"."estimated_units" > 0),
	CONSTRAINT "chk_budget_reservations_actual" CHECK ("budget_reservations"."actual_units" IS NULL OR "budget_reservations"."actual_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "budgets" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"unit" text DEFAULT 'usd_micros' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"limit_units" bigint NOT NULL,
	"reserved_units" bigint DEFAULT 0 NOT NULL,
	"spent_units" bigint DEFAULT 0 NOT NULL,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_budgets_kind" CHECK ("budgets"."kind" IN ('account', 'limit')),
	CONSTRAINT "chk_budgets_scope_type" CHECK ("budgets"."scope_type" IN ('user', 'organization', 'agent', 'run', 'eval', 'provider', 'service')),
	CONSTRAINT "chk_budgets_unit" CHECK ("budgets"."unit" IN ('tokens', 'requests', 'usd_micros')),
	CONSTRAINT "chk_budgets_status" CHECK ("budgets"."status" IN ('active', 'disabled')),
	CONSTRAINT "chk_budgets_period" CHECK (("budgets"."kind" = 'limit' AND "budgets"."period_start" IS NULL AND "budgets"."period_end" IS NULL) OR ("budgets"."kind" = 'account' AND "budgets"."period_end" > "budgets"."period_start")),
	CONSTRAINT "chk_budgets_nonnegative" CHECK ("budgets"."limit_units" >= 0 AND "budgets"."reserved_units" >= 0 AND "budgets"."spent_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "module_usage_daily" (
	"day" date NOT NULL,
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"client" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pk_module_usage_daily" PRIMARY KEY("day","kind","key","client"),
	CONSTRAINT "chk_module_usage_daily_kind" CHECK ("module_usage_daily"."kind" IN ('tool_call', 'page_open'))
);
--> statement-breakpoint
CREATE TABLE "prices" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"provider" text DEFAULT '' NOT NULL,
	"input_per_mtok" double precision,
	"output_per_mtok" double precision,
	"cached_input_per_mtok" double precision,
	"unit_price" double precision,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_prices_kind" CHECK ("prices"."kind" IN ('model', 'service')),
	CONSTRAINT "chk_prices_nonnegative" CHECK (COALESCE("prices"."input_per_mtok", 0) >= 0 AND COALESCE("prices"."output_per_mtok", 0) >= 0 AND COALESCE("prices"."cached_input_per_mtok", 0) >= 0 AND COALESCE("prices"."unit_price", 0) >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"service" text,
	"provider" text,
	"model" text,
	"profile_id" text,
	"caller" text DEFAULT '' NOT NULL,
	"units" bigint DEFAULT 0 NOT NULL,
	"unit_kind" text DEFAULT 'token' NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"cost_usd_micros" bigint,
	"price_applied" jsonb,
	"user_id" text,
	"client" text,
	"oauth_client_id" text,
	"gateway_key_id" text,
	"session_id" text,
	"run_id" text,
	"budget_idempotency_key" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_usage_events_kind" CHECK ("usage_events"."kind" IN ('model', 'service', 'audit')),
	CONSTRAINT "chk_usage_events_unit_kind" CHECK ("usage_events"."unit_kind" IN ('token', 'call', 'image', 'minute'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor_id" text NOT NULL,
	"actor_type" text NOT NULL,
	"on_behalf_of_user_id" text,
	"client_id" text,
	"request_id" text NOT NULL,
	"app_id" text NOT NULL,
	"module_id" text,
	"entity_id" text,
	"record_id" text,
	"action_id" text NOT NULL,
	"capability" text NOT NULL,
	"result" text NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_audit_events_actor_type" CHECK ("audit_events"."actor_type" IN ('human', 'agent', 'service', 'system', 'migration')),
	CONSTRAINT "chk_audit_events_result" CHECK ("audit_events"."result" IN ('success', 'denied', 'error'))
);
--> statement-breakpoint
CREATE TABLE "request_log" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"user_id" text,
	"channel" text DEFAULT 'a2a' NOT NULL,
	"status_code" integer,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_address" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_request_log_channel" CHECK ("request_log"."channel" IN ('api', 'a2a', 'cli', 'relay'))
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"status" text NOT NULL,
	"note" text,
	"submitted_by" text,
	"priority" text,
	"session_id" text,
	"fingerprint" text,
	"tool_id" text,
	"friction_kind" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"sample_sessions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_feedback_kind" CHECK ("feedback"."kind" IN ('request', 'friction')),
	CONSTRAINT "chk_feedback_priority" CHECK ("feedback"."priority" IN ('low', 'normal', 'high')),
	CONSTRAINT "chk_feedback_friction_kind" CHECK ("feedback"."friction_kind" IN ('tool_error', 'wrong_params', 'detour', 'data_quirk', 'capability_gap')),
	CONSTRAINT "chk_feedback_shape" CHECK (("feedback"."kind" = 'request' AND "feedback"."status" IN ('pending', 'accepted', 'rejected', 'done') AND "feedback"."submitted_by" IS NOT NULL AND "feedback"."priority" IS NOT NULL AND "feedback"."fingerprint" IS NULL)
        OR ("feedback"."kind" = 'friction' AND "feedback"."status" IN ('new', 'acknowledged', 'resolved', 'archived') AND "feedback"."fingerprint" IS NOT NULL AND "feedback"."friction_kind" IS NOT NULL AND "feedback"."first_seen_at" IS NOT NULL AND "feedback"."last_seen_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"preset" text DEFAULT 'custom' NOT NULL,
	"imap_host" text NOT NULL,
	"imap_port" integer NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"use_tls" boolean DEFAULT true NOT NULL,
	"use_proxy" boolean DEFAULT false NOT NULL,
	"username" text NOT NULL,
	"password_enc" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_email_accounts_user_address" UNIQUE("user_id","email_address"),
	CONSTRAINT "chk_email_accounts_preset" CHECK ("email_accounts"."preset" IN ('feishu', 'exmail', 'gmail', 'qq', '163', 'custom')),
	CONSTRAINT "chk_email_accounts_status" CHECK ("email_accounts"."status" IN ('active', 'disabled', 'error'))
);
--> statement-breakpoint
CREATE TABLE "feishu_conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"feishu_key" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uq_feishu_conversations_key" UNIQUE("feishu_key"),
	CONSTRAINT "chk_feishu_conversations_chat_type" CHECK ("feishu_conversations"."chat_type" IN ('p2p', 'group'))
);
--> statement-breakpoint
CREATE TABLE "feishu_receipts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member_computers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text DEFAULT 'e2b' NOT NULL,
	"sandbox_id" text,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone NOT NULL,
	"stopped_at" timestamp with time zone,
	"stop_reason" text,
	"minutes_billed" integer DEFAULT 0 NOT NULL,
	"budget_key" text,
	"block_started_at" timestamp with time zone,
	"client" text NOT NULL,
	"oauth_client_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_member_computers_status" CHECK ("member_computers"."status" IN ('starting', 'running', 'stopping', 'stopped', 'failed', 'lost'))
);
--> statement-breakpoint
CREATE TABLE "report_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"kind" text NOT NULL,
	"formats" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cover_fields" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visibility" text DEFAULT 'personal' NOT NULL,
	"owner_user_id" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chk_report_templates_kind" CHECK ("report_templates"."kind" IN ('report', 'presentation')),
	CONSTRAINT "chk_report_templates_visibility" CHECK ("report_templates"."visibility" IN ('team', 'personal'))
);
--> statement-breakpoint
CREATE TABLE "skill_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"skill_id" text NOT NULL,
	"version" text NOT NULL,
	"changelog" text NOT NULL,
	"file_count" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_hash" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"display_name" text NOT NULL,
	"description" text NOT NULL,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latest_version" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"owner_user_id" text NOT NULL,
	"download_count" integer DEFAULT 0 NOT NULL,
	"scan_status" text DEFAULT 'pending' NOT NULL,
	"scan_findings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"scan_version" text,
	"scanned_at" timestamp with time zone,
	"scan_reviewed_by" text,
	"scan_reviewed_at" timestamp with time zone,
	"scan_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_skills_status" CHECK ("skills"."status" IN ('active', 'archived')),
	CONSTRAINT "chk_skills_scan_status" CHECK ("skills"."scan_status" IN ('pending', 'clean', 'suspicious', 'blocked'))
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"shortcut" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_global" boolean DEFAULT false NOT NULL,
	"description" text,
	"variables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_tools" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_session_id" text,
	"artifact_action_id" text,
	"created_via" text DEFAULT 'manual' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_prompts_created_via" CHECK ("prompts"."created_via" IN ('manual', 'capture'))
);
--> statement-breakpoint
CREATE TABLE "memories" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category" text DEFAULT 'preference' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"superseded_by" text,
	"source_session_id" text,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_memories_category" CHECK ("memories"."category" IN ('preference', 'fact', 'behavior')),
	CONSTRAINT "chk_memories_status" CHECK ("memories"."status" IN ('active', 'dormant', 'archived', 'superseded')),
	CONSTRAINT "chk_memories_source" CHECK ("memories"."source" IN ('user', 'agent', 'consolidation'))
);
--> statement-breakpoint
CREATE TABLE "extension_migrations" (
	"extension_id" text NOT NULL,
	"name" text NOT NULL,
	"checksum" text NOT NULL,
	"applied_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_migrations_extension_id_name_pk" PRIMARY KEY("extension_id","name")
);
--> statement-breakpoint
CREATE TABLE "workspace_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"value_enc" text,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_refresh_tokens" ADD CONSTRAINT "auth_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_links" ADD CONSTRAINT "password_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_capabilities" ADD CONSTRAINT "role_capabilities_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_entity_policies" ADD CONSTRAINT "role_entity_policies_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_members" ADD CONSTRAINT "role_members_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_members" ADD CONSTRAINT "role_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_grants" ADD CONSTRAINT "user_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gateway_keys" ADD CONSTRAINT "gateway_keys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_bound_user_id_users_id_fk" FOREIGN KEY ("bound_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_codes" ADD CONSTRAINT "oauth_codes_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_client_id_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_grant_id_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_action_receipts" ADD CONSTRAINT "card_action_receipts_session_id_conversations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_share_reads" ADD CONSTRAINT "conversation_share_reads_session_id_conversations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversation_shares" ADD CONSTRAINT "conversation_shares_session_id_conversations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_conversations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_interrupts" ADD CONSTRAINT "run_interrupts_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_interrupts" ADD CONSTRAINT "run_interrupts_step_id_run_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."run_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_interrupts" ADD CONSTRAINT "run_interrupts_tool_call_id_run_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."run_tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_outbox" ADD CONSTRAINT "run_outbox_event_id_run_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."run_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_parent_step_id_run_steps_id_fk" FOREIGN KEY ("parent_step_id") REFERENCES "public"."run_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_calls" ADD CONSTRAINT "run_tool_calls_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tool_calls" ADD CONSTRAINT "run_tool_calls_step_id_run_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."run_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_run_id_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_profiles" ADD CONSTRAINT "run_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_profiles" ADD CONSTRAINT "run_profiles_owner_backup_user_id_users_id_fk" FOREIGN KEY ("owner_backup_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_documents" ADD CONSTRAINT "kb_documents_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_versions" ADD CONSTRAINT "kb_versions_doc_id_kb_documents_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."kb_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_links" ADD CONSTRAINT "file_links_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_session_id_conversations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "folders" ADD CONSTRAINT "folders_parent_id_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_field_dependencies" ADD CONSTRAINT "table_field_dependencies_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_field_dependencies" ADD CONSTRAINT "table_field_dependencies_depends_on_field_id_table_fields_id_fk" FOREIGN KEY ("depends_on_field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_fields" ADD CONSTRAINT "table_fields_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_source_record_id_table_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_target_record_id_table_records_id_fk" FOREIGN KEY ("target_record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_records" ADD CONSTRAINT "table_records_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_schema_versions" ADD CONSTRAINT "table_schema_versions_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_tables" ADD CONSTRAINT "table_tables_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_views" ADD CONSTRAINT "table_views_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_devices" ADD CONSTRAINT "push_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_conversations" ADD CONSTRAINT "feishu_conversations_session_id_conversations_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_conversations" ADD CONSTRAINT "feishu_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_computers" ADD CONSTRAINT "member_computers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_versions" ADD CONSTRAINT "skill_versions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memories" ADD CONSTRAINT "memories_superseded_by_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_auth_refresh_tokens_hash" ON "auth_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_auth_refresh_tokens_user" ON "auth_refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_auth_refresh_tokens_expires" ON "auth_refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_login_states_expires" ON "login_states" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_password_links_token_hash" ON "password_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_password_links_current_user" ON "password_links" USING btree ("user_id") WHERE "password_links"."consumed_at" IS NULL AND "password_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_password_links_user_created" ON "password_links" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_password_links_expires" ON "password_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_rate_limits_expires" ON "rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_users_email" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "idx_role_capabilities_capability" ON "role_capabilities" USING btree ("capability");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_role_entity_policies" ON "role_entity_policies" USING btree ("role_id","app_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_role_entity_policies_resource" ON "role_entity_policies" USING btree ("app_id","module_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_role_members_user" ON "role_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_roles_code" ON "roles" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_roles_status" ON "roles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_user_grants_key" ON "user_grants" USING btree ("kind","key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_gateway_keys_hash" ON "gateway_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "idx_gateway_keys_user" ON "gateway_keys" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_clients_status" ON "oauth_clients" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_codes_grant" ON "oauth_codes" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_oauth_codes_expiry" ON "oauth_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_oauth_grants_principal" ON "oauth_grants" USING btree ("user_id","client_id","resource");--> statement-breakpoint
CREATE INDEX "idx_oauth_grants_user_status" ON "oauth_grants" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_oauth_grants_client" ON "oauth_grants" USING btree ("client_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_oauth_tokens_hash" ON "oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_oauth_tokens_grant_type" ON "oauth_tokens" USING btree ("grant_id","token_type");--> statement-breakpoint
CREATE INDEX "idx_oauth_tokens_expiry" ON "oauth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_provider_connections_user" ON "provider_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_card_action_receipts_session" ON "card_action_receipts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_card_action_receipts_user" ON "card_action_receipts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_share_reads_user" ON "conversation_share_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_conversation_shares_user" ON "conversation_shares" USING btree ("shared_with");--> statement-breakpoint
CREATE INDEX "idx_conversations_user_updated" ON "conversations" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_conversations_app_id" ON "conversations" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_conversations_channel" ON "conversations" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "idx_conversations_pinned" ON "conversations" USING btree ("user_id","pinned_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_session_seq" ON "messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_events_run_seq" ON "run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_events_run_idempotency" ON "run_events" USING btree ("run_id","idempotency_key") WHERE "run_events"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_run_events_run_created" ON "run_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_events_step" ON "run_events" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "idx_run_events_created" ON "run_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_run_interrupts_run_created" ON "run_interrupts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_interrupts_assignee_pending" ON "run_interrupts" USING btree ("assignee_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_interrupts_step" ON "run_interrupts" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "idx_run_interrupts_tool" ON "run_interrupts" USING btree ("tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_outbox_event_topic" ON "run_outbox" USING btree ("event_id","topic");--> statement-breakpoint
CREATE INDEX "idx_run_outbox_delivery" ON "run_outbox" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_run_outbox_delivered" ON "run_outbox" USING btree ("delivered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_steps_run_key_attempt" ON "run_steps" USING btree ("run_id","step_key","attempt");--> statement-breakpoint
CREATE INDEX "idx_run_steps_run_created" ON "run_steps" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_steps_parent" ON "run_steps" USING btree ("parent_step_id");--> statement-breakpoint
CREATE INDEX "idx_run_steps_claim" ON "run_steps" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_run_tool_calls_run_created" ON "run_tool_calls" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_run_tool_calls_step" ON "run_tool_calls" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "idx_run_tool_calls_interrupt" ON "run_tool_calls" USING btree ("interrupt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_run_tool_calls_run_idempotency" ON "run_tool_calls" USING btree ("run_id","idempotency_key") WHERE "run_tool_calls"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_source" ON "runs" USING btree ("kind","source_kind","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runs_owner_idempotency" ON "runs" USING btree ("owner_user_id","kind","idempotency_key") WHERE "runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runs_owner_created" ON "runs" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runs_session" ON "runs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_runs_root" ON "runs" USING btree ("root_run_id");--> statement-breakpoint
CREATE INDEX "idx_runs_parent" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "idx_runs_claim" ON "runs" USING btree ("status","desired_state","not_before","priority");--> statement-breakpoint
CREATE INDEX "idx_runs_stale_lease" ON "runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_runs_created" ON "runs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_automation_occurrences_task" ON "automation_occurrences" USING btree ("task_id","run_created_at");--> statement-breakpoint
CREATE INDEX "idx_automation_occurrences_owner" ON "automation_occurrences" USING btree ("owner_user_id","projected_at");--> statement-breakpoint
CREATE INDEX "idx_automations_user" ON "automations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_automations_next_run" ON "automations" USING btree ("enabled","next_run_at");--> statement-breakpoint
CREATE INDEX "idx_run_profiles_shared" ON "run_profiles" USING btree ("is_shared");--> statement-breakpoint
CREATE INDEX "idx_run_profiles_backup_owner" ON "run_profiles" USING btree ("owner_backup_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_documents_doc_scope" ON "kb_documents" USING btree ("doc_id","scope");--> statement-breakpoint
CREATE INDEX "idx_kb_documents_visibility" ON "kb_documents" USING btree ("visibility","owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_kb_documents_status" ON "kb_documents" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_kb_documents_updated_at" ON "kb_documents" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_kb_documents_folder" ON "kb_documents" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_kb_documents_search" ON "kb_documents" USING gin ("search_tsv");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_versions_doc_version" ON "kb_versions" USING btree ("doc_id","version");--> statement-breakpoint
CREATE INDEX "idx_kb_versions_created_at" ON "kb_versions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_file_links_target" ON "file_links" USING btree ("target_type","target_id","slot","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_files_storage_key" ON "files" USING btree ("storage_key") WHERE "files"."storage_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_files_folder" ON "files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_files_drive_kb" ON "files" USING btree ("scope","visibility","owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_files_drive_tables" ON "files" USING btree ("scope","base_id");--> statement-breakpoint
CREATE INDEX "idx_files_drive_ext" ON "files" USING btree ("scope","owner_key");--> statement-breakpoint
CREATE INDEX "idx_files_session" ON "files" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_files_run" ON "files" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_files_created_by" ON "files" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_files_status" ON "files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_folders_parent" ON "folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_folders_kb" ON "folders" USING btree ("scope","visibility","owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_folders_tables" ON "folders" USING btree ("scope","base_id");--> statement-breakpoint
CREATE INDEX "idx_folders_ext" ON "folders" USING btree ("scope","owner_key");--> statement-breakpoint
CREATE INDEX "idx_shares_principal" ON "shares" USING btree ("principal_type","principal_id","resource_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_members_project_user" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_projects_status" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_projects_owner" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_task_comments_task" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_project" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_parent" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_assignee" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_table_bases_owner" ON "table_bases" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_table_bases_visibility" ON "table_bases" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "idx_table_bases_updated" ON "table_bases" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_table_field_dependencies_source" ON "table_field_dependencies" USING btree ("depends_on_field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_fields_table_name" ON "table_fields" USING btree ("table_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_fields_primary" ON "table_fields" USING btree ("table_id") WHERE "table_fields"."is_primary" = true AND "table_fields"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_table_fields_table_position" ON "table_fields" USING btree ("table_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_recompute_jobs_idempotency" ON "table_recompute_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_table_recompute_jobs_status" ON "table_recompute_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_record_links_field_source_target" ON "table_record_links" USING btree ("field_id","source_record_id","target_record_id");--> statement-breakpoint
CREATE INDEX "idx_table_record_links_source" ON "table_record_links" USING btree ("field_id","source_record_id","position");--> statement-breakpoint
CREATE INDEX "idx_table_record_links_target" ON "table_record_links" USING btree ("field_id","target_record_id");--> statement-breakpoint
CREATE INDEX "idx_table_records_table_created" ON "table_records" USING btree ("table_id","created_at","id");--> statement-breakpoint
CREATE INDEX "idx_table_records_table_updated" ON "table_records" USING btree ("table_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_table_records_deleted" ON "table_records" USING btree ("table_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_schema_versions_table_version" ON "table_schema_versions" USING btree ("table_id","version");--> statement-breakpoint
CREATE INDEX "idx_table_schema_versions_table_created" ON "table_schema_versions" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_tables_base_name" ON "table_tables" USING btree ("base_id","name");--> statement-breakpoint
CREATE INDEX "idx_table_tables_base_position" ON "table_tables" USING btree ("base_id","position");--> statement-breakpoint
CREATE INDEX "idx_table_views_table_position" ON "table_views" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "idx_table_views_owner" ON "table_views" USING btree ("owner_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_deliveries_channel_recipient" ON "notification_deliveries" USING btree ("notification_id","channel","recipient");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_claim" ON "notification_deliveries" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_notification_deliveries_updated" ON "notification_deliveries" USING btree ("status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_user_dedupe" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread_created" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_run" ON "notifications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_interrupt" ON "notifications" USING btree ("interrupt_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_event" ON "notifications" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_agent" ON "notifications" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_push_devices_token" ON "push_devices" USING btree ("token");--> statement-breakpoint
CREATE INDEX "idx_push_devices_user_active" ON "push_devices" USING btree ("user_id") WHERE "push_devices"."disabled_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_budget_ledger_account_operation" ON "budget_ledger" USING btree ("account_id","operation_key");--> statement-breakpoint
CREATE INDEX "idx_budget_ledger_account_created" ON "budget_ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_budget_ledger_reservation" ON "budget_ledger" USING btree ("reservation_id");--> statement-breakpoint
CREATE INDEX "idx_budget_ledger_created" ON "budget_ledger" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_budget_reservations_account_key" ON "budget_reservations" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_budget_reservations_key" ON "budget_reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_budget_reservations_status_expiry" ON "budget_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_budget_reservations_user_created" ON "budget_reservations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_budget_reservations_run" ON "budget_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_budgets_account" ON "budgets" USING btree ("scope_type","scope_id","unit","period_start","period_end") WHERE "budgets"."kind" = 'account';--> statement-breakpoint
CREATE UNIQUE INDEX "uq_budgets_limit" ON "budgets" USING btree ("scope_type","scope_id","unit") WHERE "budgets"."kind" = 'limit';--> statement-breakpoint
CREATE INDEX "idx_budgets_scope" ON "budgets" USING btree ("scope_type","scope_id","status");--> statement-breakpoint
CREATE INDEX "idx_budgets_period" ON "budgets" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE INDEX "idx_module_usage_daily_kind_day" ON "module_usage_daily" USING btree ("kind","day");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prices_target" ON "prices" USING btree ("kind","target","provider");--> statement-breakpoint
CREATE INDEX "idx_usage_events_created" ON "usage_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_events_user_created" ON "usage_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_events_kind_created" ON "usage_events" USING btree ("kind","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_events_service_created" ON "usage_events" USING btree ("service","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_events_session" ON "usage_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_usage_events_gateway_key" ON "usage_events" USING btree ("gateway_key_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_events_budget_key" ON "usage_events" USING btree ("budget_idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_audit_events_created" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_actor_created" ON "audit_events" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_resource_created" ON "audit_events" USING btree ("app_id","entity_id","record_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_app_action_created" ON "audit_events" USING btree ("app_id","action_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_audit_events_request" ON "audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "idx_request_log_app" ON "request_log" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_request_log_created" ON "request_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_request_log_user" ON "request_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feedback_fingerprint" ON "feedback" USING btree ("fingerprint") WHERE "feedback"."fingerprint" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_feedback_kind_status" ON "feedback" USING btree ("kind","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_feedback_tool" ON "feedback" USING btree ("tool_id");--> statement-breakpoint
CREATE INDEX "idx_email_accounts_user" ON "email_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_conversations_user" ON "feishu_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_receipts_received" ON "feishu_receipts" USING btree ("received_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_member_computers_active_user" ON "member_computers" USING btree ("user_id") WHERE "member_computers"."status" IN ('starting', 'running', 'stopping');--> statement-breakpoint
CREATE INDEX "idx_member_computers_status" ON "member_computers" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_member_computers_user_started" ON "member_computers" USING btree ("user_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_report_templates_visibility" ON "report_templates" USING btree ("visibility","updated_at");--> statement-breakpoint
CREATE INDEX "idx_report_templates_owner" ON "report_templates" USING btree ("owner_user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skill_versions_skill_version" ON "skill_versions" USING btree ("skill_id","version");--> statement-breakpoint
CREATE INDEX "idx_skill_versions_skill" ON "skill_versions" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_skills_name" ON "skills" USING btree ("name");--> statement-breakpoint
CREATE INDEX "idx_skills_status" ON "skills" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_skills_updated_at" ON "skills" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_skills_scan_status" ON "skills" USING btree ("scan_status");--> statement-breakpoint
CREATE INDEX "idx_prompts_user" ON "prompts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_prompts_artifact_action" ON "prompts" USING btree ("artifact_action_id");--> statement-breakpoint
CREATE INDEX "idx_memories_user_status" ON "memories" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_memories_user_category" ON "memories" USING btree ("user_id","category");