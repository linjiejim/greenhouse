CREATE TABLE "chat_artifact_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text NOT NULL,
	"result" text DEFAULT '{}' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_files" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"source" text DEFAULT 'agent' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_datasets" (
	"id" serial PRIMARY KEY NOT NULL,
	"category" text NOT NULL,
	"difficulty" text DEFAULT 'medium' NOT NULL,
	"question" text NOT NULL,
	"ground_truth" text NOT NULL,
	"expected_behavior" text,
	"tags" text DEFAULT '[]' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"is_negative" integer DEFAULT 0 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"source" text DEFAULT 'manual' NOT NULL,
	"source_session_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"dataset_id" integer NOT NULL,
	"session_id" text,
	"answer" text,
	"references_used" text DEFAULT '[]' NOT NULL,
	"duration_ms" integer,
	"ttfb_ms" integer,
	"answer_length" integer,
	"score_accuracy" double precision,
	"score_completeness" double precision,
	"score_relevance" double precision,
	"score_speed" double precision,
	"score_final" double precision,
	"judge_reasoning" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"status" text DEFAULT 'running' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"avg_score" double precision,
	"avg_accuracy" double precision,
	"avg_completeness" double precision,
	"avg_relevance" double precision,
	"avg_speed" double precision,
	"model" text,
	"profile_id" text DEFAULT 'team' NOT NULL,
	"config" text DEFAULT '{}' NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_eval_results" (
	"id" serial PRIMARY KEY NOT NULL,
	"message_id" text NOT NULL,
	"session_id" text NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"verdict" text,
	"score_final" double precision,
	"classification" text DEFAULT '{}' NOT NULL,
	"dimensions" text DEFAULT '{}' NOT NULL,
	"consistency_detail" text DEFAULT '{}' NOT NULL,
	"citation_issues" text DEFAULT '[]' NOT NULL,
	"suggestions" text DEFAULT '[]' NOT NULL,
	"judge_reasoning" text,
	"references_checked" text DEFAULT '[]' NOT NULL,
	"score_accuracy" double precision,
	"score_faithfulness" double precision,
	"score_completeness" double precision,
	"score_hallucination" double precision,
	"discrepancies" text DEFAULT '[]' NOT NULL,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"eval_session_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chat_eval_results_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "usage_budget_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text NOT NULL,
	"unit" text DEFAULT 'tokens' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"limit_units" bigint NOT NULL,
	"reserved_units" bigint DEFAULT 0 NOT NULL,
	"spent_units" bigint DEFAULT 0 NOT NULL,
	"legacy_spent_units" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_usage_budget_accounts_period" CHECK ("usage_budget_accounts"."period_end" > "usage_budget_accounts"."period_start"),
	CONSTRAINT "chk_usage_budget_accounts_nonnegative" CHECK ("usage_budget_accounts"."limit_units" >= 0 AND "usage_budget_accounts"."reserved_units" >= 0 AND "usage_budget_accounts"."spent_units" >= 0 AND "usage_budget_accounts"."legacy_spent_units" >= 0 AND "usage_budget_accounts"."legacy_spent_units" <= "usage_budget_accounts"."spent_units")
);
--> statement-breakpoint
CREATE TABLE "usage_budget_ledger" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"reservation_id" text,
	"operation_key" text NOT NULL,
	"entry_type" text NOT NULL,
	"delta_reserved_units" bigint DEFAULT 0 NOT NULL,
	"delta_spent_units" bigint DEFAULT 0 NOT NULL,
	"reserved_units_after" bigint NOT NULL,
	"spent_units_after" bigint NOT NULL,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_usage_budget_ledger_balances" CHECK ("usage_budget_ledger"."reserved_units_after" >= 0 AND "usage_budget_ledger"."spent_units_after" >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_budget_reservations" (
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
	"metadata" text DEFAULT '{}' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_usage_budget_reservations_estimate" CHECK ("usage_budget_reservations"."estimated_units" > 0),
	CONSTRAINT "chk_usage_budget_reservations_actual" CHECK ("usage_budget_reservations"."actual_units" IS NULL OR "usage_budget_reservations"."actual_units" >= 0)
);
--> statement-breakpoint
CREATE TABLE "account_password_links" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"purpose" text NOT NULL,
	"token_hash" text NOT NULL,
	"issued_auth_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"delivery_status" text DEFAULT 'pending' NOT NULL,
	"delivery_error" text
);
--> statement-breakpoint
CREATE TABLE "scheduled_task_runtime_occurrences" (
	"runtime_run_id" text PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"owner_user_id" text NOT NULL,
	"status" text NOT NULL,
	"runtime_version" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"run_created_at" timestamp with time zone NOT NULL,
	"projected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_provider_tokens" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"workspace_id" text,
	"access_token" text,
	"refresh_token" text,
	"provider_credential" text,
	"token_type" text DEFAULT 'Bearer' NOT NULL,
	"scope" text,
	"expires_at" timestamp with time zone,
	"provider_user_id" text,
	"provider_email" text,
	"provider_name" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_user_provider_workspace" UNIQUE NULLS NOT DISTINCT("user_id","provider","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "feishu_conversations" (
	"id" serial PRIMARY KEY NOT NULL,
	"feishu_key" text NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"chat_id" text NOT NULL,
	"chat_type" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_message_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_feishu_conversations_key" UNIQUE("feishu_key")
);
--> statement-breakpoint
CREATE TABLE "feishu_message_receipts" (
	"message_id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_profile_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" integer NOT NULL,
	"version" integer NOT NULL,
	"manifest_hash" text NOT NULL,
	"change_log" text DEFAULT '' NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_profile_id" text DEFAULT 'team' NOT NULL,
	"model_id" text,
	"tools" text DEFAULT '[]' NOT NULL,
	"system_prompt" text NOT NULL,
	"max_steps" integer DEFAULT 12 NOT NULL,
	"avatar" text DEFAULT '{}' NOT NULL,
	"purpose" text,
	"audience" text,
	"risk_level" text DEFAULT 'medium' NOT NULL,
	"budget_policy" text DEFAULT '{}' NOT NULL,
	"eval_refs" text DEFAULT '[]' NOT NULL,
	"owner_backup_user_id" text,
	"review_due_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_custom_profile_versions_profile_version" UNIQUE("profile_id","version")
);
--> statement-breakpoint
CREATE TABLE "kb_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" integer NOT NULL,
	"author_user_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "kb_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"from_doc_id" integer NOT NULL,
	"to_doc_id" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "drive_files" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"folder_id" integer,
	"name" text NOT NULL,
	"cos_key" text NOT NULL,
	"content_type" text,
	"size" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"visibility" text,
	"owner_user_id" text,
	"base_id" integer,
	"uploaded_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_drive_files_scope_owner" CHECK ((
        ("drive_files"."scope" = 'kb' AND "drive_files"."base_id" IS NULL AND "drive_files"."visibility" IS NOT NULL AND ("drive_files"."visibility" = 'team' OR "drive_files"."owner_user_id" IS NOT NULL))
        OR ("drive_files"."scope" = 'tables' AND "drive_files"."base_id" IS NOT NULL AND "drive_files"."visibility" IS NULL AND "drive_files"."owner_user_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "drive_folders" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"parent_id" integer,
	"name" text NOT NULL,
	"visibility" text,
	"owner_user_id" text,
	"base_id" integer,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_drive_folders_scope_owner" CHECK ((
        ("drive_folders"."scope" = 'kb' AND "drive_folders"."base_id" IS NULL AND "drive_folders"."visibility" IS NOT NULL AND ("drive_folders"."visibility" = 'team' OR "drive_folders"."owner_user_id" IS NOT NULL))
        OR ("drive_folders"."scope" = 'tables' AND "drive_folders"."base_id" IS NOT NULL AND "drive_folders"."visibility" IS NULL AND "drive_folders"."owner_user_id" IS NULL)
      ))
);
--> statement-breakpoint
CREATE TABLE "email_send_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_scope" text NOT NULL,
	"account_id" integer,
	"from_address" text NOT NULL,
	"subject" text NOT NULL,
	"recipients" text DEFAULT '[]' NOT NULL,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"origin" text NOT NULL,
	"session_id" text,
	"task_id" integer,
	"status" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_frictions" (
	"id" serial PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"tool_id" text,
	"kind" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"sample_sessions" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"resolution_note" text,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tool_frictions_fingerprint_unique" UNIQUE("fingerprint")
);
--> statement-breakpoint
CREATE TABLE "platform_app_releases" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"version" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"manifest" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"git_commit" text,
	"created_by" text,
	"activated_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
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
	"summary" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_role_bindings" (
	"role_id" text NOT NULL,
	"user_id" text NOT NULL,
	"assigned_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_role_bindings_role_id_user_id_pk" PRIMARY KEY("role_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "platform_role_capabilities" (
	"role_id" text NOT NULL,
	"capability" text NOT NULL,
	"assigned_by" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_role_capabilities_role_id_capability_pk" PRIMARY KEY("role_id","capability")
);
--> statement-breakpoint
CREATE TABLE "platform_role_entity_policies" (
	"id" text PRIMARY KEY NOT NULL,
	"role_id" text NOT NULL,
	"app_id" text NOT NULL,
	"module_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"scopes" text DEFAULT '[]' NOT NULL,
	"field_policies" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_roles" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"system_protected" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_user_capability_overrides" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"capability" text NOT NULL,
	"effect" text NOT NULL,
	"granted_by" text,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_user_capability_overrides_org_id_user_id_capability_pk" PRIMARY KEY("org_id","user_id","capability")
);
--> statement-breakpoint
CREATE TABLE "platform_user_entity_policy_overrides" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"app_id" text NOT NULL,
	"module_id" text NOT NULL,
	"entity_id" text NOT NULL,
	"effect" text NOT NULL,
	"scopes" text DEFAULT '[]' NOT NULL,
	"field_policies" text DEFAULT '{}' NOT NULL,
	"granted_by" text,
	"reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_user_workbench_preferences" (
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"preferences" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "platform_user_workbench_preferences_org_id_user_id_pk" PRIMARY KEY("org_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "platform_oauth_authorization_codes" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"redirect_uri" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text DEFAULT '[]' NOT NULL,
	"code_challenge" text NOT NULL,
	"code_challenge_method" text DEFAULT 'S256' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_oauth_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text DEFAULT '[]' NOT NULL,
	"token_endpoint_auth_method" text DEFAULT 'none' NOT NULL,
	"client_secret_hash" text,
	"bound_user_id" text,
	"allowed_scopes" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text DEFAULT '[]' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "platform_oauth_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_type" text NOT NULL,
	"resource" text NOT NULL,
	"scopes" text DEFAULT '[]' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_automation_outbox" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"record_id" integer NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"idempotency_key" text NOT NULL,
	"recursion_depth" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_automation_rules" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_id" integer NOT NULL,
	"table_id" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'disabled' NOT NULL,
	"trigger" text NOT NULL,
	"config" jsonb NOT NULL,
	"execution_user_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_automation_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"rule_id" integer NOT NULL,
	"outbox_id" integer,
	"status" text NOT NULL,
	"actions_completed" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_base_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_bases" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"owner_id" text NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_dashboard_widgets" (
	"id" serial PRIMARY KEY NOT NULL,
	"dashboard_id" integer NOT NULL,
	"table_id" integer,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"config" text DEFAULT '{}' NOT NULL,
	"layout" text DEFAULT '{"x":0,"y":0,"w":6,"h":4}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_dashboards" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_field_dependencies" (
	"field_id" integer NOT NULL,
	"depends_on_field_id" integer NOT NULL,
	"dependency_type" text NOT NULL,
	CONSTRAINT "table_field_dependencies_field_id_depends_on_field_id_pk" PRIMARY KEY("field_id","depends_on_field_id")
);
--> statement-breakpoint
CREATE TABLE "table_fields" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"is_primary" boolean DEFAULT false NOT NULL,
	"config" text DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_forms" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_id" integer NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"config" jsonb NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"rule_id" integer,
	"record_id" integer,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_recompute_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_id" integer NOT NULL,
	"field_id" integer,
	"record_id" integer,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_record_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"record_id" integer NOT NULL,
	"field_id" integer NOT NULL,
	"drive_file_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_record_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"field_id" integer NOT NULL,
	"source_record_id" integer NOT NULL,
	"target_record_id" integer NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_id" integer NOT NULL,
	"values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_values" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"computed_revision" integer DEFAULT 1 NOT NULL,
	"computed_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"updated_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_schema_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_id" integer NOT NULL,
	"version" integer NOT NULL,
	"schema_snapshot" jsonb NOT NULL,
	"change_type" text NOT NULL,
	"changed_by" text NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "table_tables" (
	"id" serial PRIMARY KEY NOT NULL,
	"base_id" integer NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"position" integer DEFAULT 0 NOT NULL,
	"schema_revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "table_views" (
	"id" serial PRIMARY KEY NOT NULL,
	"table_id" integer NOT NULL,
	"name" text NOT NULL,
	"type" text DEFAULT 'grid' NOT NULL,
	"scope" text DEFAULT 'shared' NOT NULL,
	"owner_id" text,
	"config" text DEFAULT '{}' NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_gates" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text,
	"kind" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"note" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_node_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"node_id" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"session_id" text,
	"inputs" text DEFAULT '{}' NOT NULL,
	"outputs" text,
	"checks_result" text,
	"error" text,
	"tokens" integer,
	"duration_ms" integer,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"workflow_id" integer NOT NULL,
	"workflow_version" integer NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"task_input" text NOT NULL,
	"graph" text,
	"budget" text DEFAULT '{}' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"completed" integer DEFAULT 0 NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"summary" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflows" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"graph" text DEFAULT '{}' NOT NULL,
	"created_from_session_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_artifacts" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"path" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"content_type" text DEFAULT 'application/octet-stream' NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"user_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"action" text,
	"input_hash" text NOT NULL,
	"input_json" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_run_outbox" (
	"run_id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"message_id" text NOT NULL,
	"content" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"workspace_id" integer NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"dispatch_id" text,
	"title" text NOT NULL,
	"original_prompt" text NOT NULL,
	"prompt" text NOT NULL,
	"input_manifest" text DEFAULT '[]' NOT NULL,
	"model" text NOT NULL,
	"fallback_model" text,
	"container_id" text,
	"relay_client_id" text,
	"session_id" text,
	"max_wall_ms" integer DEFAULT 7200000 NOT NULL,
	"max_requests" integer DEFAULT 300 NOT NULL,
	"used_requests" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"result_summary" text,
	"failure_code" text,
	"error" text,
	"journal_storage_key" text,
	"queued_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"disk_bytes" bigint DEFAULT 0 NOT NULL,
	"cos_archive_key" text,
	"last_used_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "runtime_artifacts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"tool_call_id" text,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"path" text,
	"content_type" text,
	"size_bytes" bigint,
	"sha256" text,
	"storage_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_runtime_artifacts_size" CHECK ("runtime_artifacts"."size_bytes" IS NULL OR "runtime_artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "runtime_events" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"actor_user_id" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chk_runtime_events_seq" CHECK ("runtime_events"."seq" > 0)
);
--> statement-breakpoint
CREATE TABLE "runtime_interrupts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"tool_call_id" text,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"canonical_input_hash" text,
	"risk_level" text,
	"assignee_user_id" text NOT NULL,
	"expires_at" timestamp with time zone,
	"decision" text,
	"decided_by_user_id" text,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_runtime_interrupts_version" CHECK ("runtime_interrupts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "runtime_outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"event_id" text NOT NULL,
	"topic" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 10 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_runtime_outbox_attempts" CHECK ("runtime_outbox"."attempts" >= 0 AND "runtime_outbox"."max_attempts" > 0),
	CONSTRAINT "chk_runtime_outbox_version" CHECK ("runtime_outbox"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "runtime_runs" (
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
	"input" text DEFAULT '{}' NOT NULL,
	"output" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_runtime_runs_attempts" CHECK ("runtime_runs"."attempt" >= 0 AND "runtime_runs"."max_attempts" > 0),
	CONSTRAINT "chk_runtime_runs_version" CHECK ("runtime_runs"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "runtime_steps" (
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
	"input" text DEFAULT '{}' NOT NULL,
	"output" text,
	"error_code" text,
	"error_message" text,
	"tokens_used" bigint DEFAULT 0 NOT NULL,
	"requests_used" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	"duration_ms" bigint,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_runtime_steps_attempt" CHECK ("runtime_steps"."attempt" > 0),
	CONSTRAINT "chk_runtime_steps_usage" CHECK ("runtime_steps"."tokens_used" >= 0 AND "runtime_steps"."requests_used" >= 0 AND "runtime_steps"."cost_micros" >= 0 AND ("runtime_steps"."duration_ms" IS NULL OR "runtime_steps"."duration_ms" >= 0)),
	CONSTRAINT "chk_runtime_steps_version" CHECK ("runtime_steps"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "runtime_tool_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"step_id" text,
	"tool_name" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"input" text DEFAULT '{}' NOT NULL,
	"output" text,
	"canonical_input_hash" text NOT NULL,
	"risk_level" text NOT NULL,
	"idempotency_key" text,
	"interrupt_id" text,
	"platform_audit_event_id" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_runtime_tool_calls_version" CHECK ("runtime_tool_calls"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_attempts" (
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
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "chk_notification_delivery_attempts" CHECK ("notification_delivery_attempts"."attempts" >= 0 AND "notification_delivery_attempts"."max_attempts" > 0 AND "notification_delivery_attempts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"payload" text DEFAULT '{}' NOT NULL,
	"run_id" text,
	"interrupt_id" text,
	"event_id" text,
	"agent_id" text,
	"dedupe_key" text NOT NULL,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_profiles" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_gateway_models" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "llm_upstreams" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crud_demo_items" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "user_profiles" CASCADE;--> statement-breakpoint
DROP TABLE "llm_gateway_models" CASCADE;--> statement-breakpoint
DROP TABLE "llm_upstreams" CASCADE;--> statement-breakpoint
DROP TABLE "crud_demo_items" CASCADE;--> statement-breakpoint
-- Email accounts: the 0.6 schema stored one encrypted credential blob per
-- account; the revived mailbox model needs explicit IMAP/SMTP settings that
-- cannot be derived from it. Accounts are re-added from Settings → Email.
DROP TABLE "email_accounts" CASCADE;--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
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
	"password_encrypted" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_email_account_user_address" UNIQUE("user_id","email_address")
);--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_email_accounts_user" ON "email_accounts" USING btree ("user_id");--> statement-breakpoint
DROP INDEX "idx_session_shares_unread";--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "profile_id" SET DEFAULT 'team';--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "monthly_token_limit" SET DEFAULT 100000000;--> statement-breakpoint
ALTER TABLE "api_audit_log" ALTER COLUMN "channel" SET DEFAULT 'a2a';--> statement-breakpoint
-- The public/external surface (guest login, /api/v1, A2A keys) is gone.
-- External accounts can no longer sign in; their sessions and keys go with them.
UPDATE "users"
SET "status" = 'disabled',
    "password_hash" = 'EXTERNAL_ACCOUNT_RETIRED_NOLOGIN',
    "updated_at" = NOW()
WHERE "role" = 'external';--> statement-breakpoint
DELETE FROM "refresh_tokens"
WHERE "user_id" IN (SELECT "id" FROM "users" WHERE "role" = 'external');--> statement-breakpoint
DELETE FROM "api_clients" AS "client"
WHERE "client"."user_id" IS NULL
   OR "client"."channel" NOT IN ('a2a', 'relay')
   OR NOT EXISTS (SELECT 1 FROM "users" AS "account" WHERE "account"."id" = "client"."user_id");--> statement-breakpoint
ALTER TABLE "api_clients" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "api_clients" ALTER COLUMN "channel" SET DEFAULT 'a2a';--> statement-breakpoint
-- Agent-to-agent keys are superseded by MCP OAuth machine clients.
UPDATE "api_clients" SET "status" = 'disabled', "updated_at" = NOW() WHERE "channel" = 'a2a' AND "status" = 'active';--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ALTER COLUMN "profile_id" SET DEFAULT 'team';--> statement-breakpoint
ALTER TABLE "custom_profiles" ALTER COLUMN "base_profile_id" SET DEFAULT 'team';--> statement-breakpoint
-- The public `default` profile is retired; rows fold into the team preset
-- (whose id the runtime resolves to the built-in agent).
UPDATE "sessions" SET "profile_id" = 'team' WHERE "profile_id" = 'default';--> statement-breakpoint
UPDATE "eval_runs" SET "profile_id" = 'team' WHERE "profile_id" = 'default';--> statement-breakpoint
UPDATE "scheduled_tasks" SET "profile_id" = 'team' WHERE "profile_id" = 'default';--> statement-breakpoint
UPDATE "custom_profiles" SET "base_profile_id" = 'team' WHERE "base_profile_id" = 'default';--> statement-breakpoint
UPDATE "llm_usage" SET "profile_id" = 'team' WHERE "profile_id" = 'default';--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "llm_usage" ADD COLUMN "budget_idempotency_key" text;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN "auth_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "auth_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prompts" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "user_prompts" ADD COLUMN "variables" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prompts" ADD COLUMN "expected_tools" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_prompts" ADD COLUMN "source_session_id" text;--> statement-breakpoint
ALTER TABLE "user_prompts" ADD COLUMN "artifact_action_id" text;--> statement-breakpoint
ALTER TABLE "user_prompts" ADD COLUMN "created_via" text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_webhook" text;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_email" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_wecom" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "notify_feishu" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD COLUMN "unattended_tools" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "model_id" text;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "tools" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "system_prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "max_steps" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "avatar" text DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "current_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "published_version" integer;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "lifecycle_status" text DEFAULT 'draft' NOT NULL;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "lifecycle_note" text;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "owner_backup_user_id" text;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "reviewed_by" text;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD COLUMN "next_review_at" timestamp with time zone;--> statement-breakpoint
-- Custom agents stored one jsonb manifest; the columns are the manifest now.
UPDATE "custom_profiles"
SET "description" = NULLIF("data"->>'description', ''),
    "system_prompt" = COALESCE("data"->>'system_prompt', ''),
    "tools" = COALESCE(("data"->'tools')::text, '[]'),
    "max_steps" = COALESCE(("data"->>'max_steps')::integer, 12),
    "model_id" = NULLIF("data"#>>'{model,id}', ''),
    "avatar" = COALESCE(("data"->'avatar')::text, '{}');--> statement-breakpoint
ALTER TABLE "custom_profiles" ALTER COLUMN "system_prompt" DROP DEFAULT;--> statement-breakpoint
-- Every existing agent becomes immutable draft v1 under the version contract;
-- sharing re-opens once a super publishes a reviewed version.
INSERT INTO "custom_profile_versions" (
	"profile_id", "version", "manifest_hash", "change_log", "name", "description",
	"base_profile_id", "model_id", "tools", "system_prompt", "max_steps", "avatar",
	"purpose", "audience", "risk_level", "budget_policy", "eval_refs",
	"owner_backup_user_id", "review_due_at", "created_by", "created_at"
)
SELECT
	cp."id", 1,
	encode(sha256(convert_to(json_build_object(
		'name', cp."name", 'description', cp."description", 'base_profile_id', cp."base_profile_id",
		'model_id', cp."model_id", 'tools', cp."tools", 'system_prompt', cp."system_prompt",
		'max_steps', cp."max_steps", 'avatar', cp."avatar", 'purpose', NULL::text,
		'audience', NULL::text, 'risk_level', 'medium', 'budget_policy', '{}', 'eval_refs', '[]',
		'owner_backup_user_id', NULL::text, 'review_due_at', NULL::text
	)::text, 'UTF8')), 'hex'),
	'Migrated mutable agent as immutable draft v1',
	cp."name", cp."description", cp."base_profile_id", cp."model_id", cp."tools",
	cp."system_prompt", cp."max_steps", cp."avatar", NULL, NULL, 'medium', '{}', '[]',
	NULL, NULL, cp."user_id", cp."created_at"
FROM "custom_profiles" cp;--> statement-breakpoint
UPDATE "custom_profiles"
SET "is_shared" = false, "lifecycle_status" = 'draft', "current_version" = 1,
	"published_version" = NULL, "updated_at" = GREATEST("updated_at", NOW());--> statement-breakpoint
-- Pin persisted execution surfaces to v1 so later draft edits cannot change
-- already-created conversations, schedules or eval evidence.
UPDATE "sessions" SET "profile_id" = "profile_id" || '@1' WHERE "profile_id" ~ '^custom:[0-9]+$';--> statement-breakpoint
UPDATE "scheduled_tasks" SET "profile_id" = "profile_id" || '@1' WHERE "profile_id" ~ '^custom:[0-9]+$';--> statement-breakpoint
UPDATE "eval_runs" SET "profile_id" = "profile_id" || '@1' WHERE "profile_id" ~ '^custom:[0-9]+$';--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "is_template" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "folder_id" integer;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "sort_order" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "_tokens_a" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "_tokens_b" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD COLUMN "_tokens_c" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "title" text DEFAULT '' NOT NULL;--> statement-breakpoint
UPDATE "user_memories" SET "title" = left("content", 80) WHERE "title" = '';--> statement-breakpoint
ALTER TABLE "user_memories" ALTER COLUMN "title" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "pinned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "source" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "superseded_by" integer;--> statement-breakpoint
ALTER TABLE "user_memories" ADD COLUMN "last_used_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "scan_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "scan_findings" text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "scan_version" text;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "scanned_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "scan_reviewed_by" text;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "scan_reviewed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "scan_note" text;--> statement-breakpoint
ALTER TABLE "chat_artifact_receipts" ADD CONSTRAINT "chat_artifact_receipts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_files" ADD CONSTRAINT "chat_files_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_run_id_eval_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."eval_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "eval_results" ADD CONSTRAINT "eval_results_dataset_id_eval_datasets_id_fk" FOREIGN KEY ("dataset_id") REFERENCES "public"."eval_datasets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_password_links" ADD CONSTRAINT "account_password_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_provider_tokens" ADD CONSTRAINT "user_provider_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_conversations" ADD CONSTRAINT "feishu_conversations_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feishu_conversations" ADD CONSTRAINT "feishu_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_profile_versions" ADD CONSTRAINT "custom_profile_versions_profile_id_custom_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."custom_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_comments" ADD CONSTRAINT "kb_comments_doc_id_knowledge_base_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_links" ADD CONSTRAINT "kb_links_from_doc_id_knowledge_base_id_fk" FOREIGN KEY ("from_doc_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "kb_links" ADD CONSTRAINT "kb_links_to_doc_id_knowledge_base_id_fk" FOREIGN KEY ("to_doc_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_files" ADD CONSTRAINT "drive_files_folder_id_drive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."drive_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "drive_folders" ADD CONSTRAINT "drive_folders_parent_id_drive_folders_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."drive_folders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_bindings" ADD CONSTRAINT "platform_role_bindings_role_id_platform_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."platform_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_bindings" ADD CONSTRAINT "platform_role_bindings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_capabilities" ADD CONSTRAINT "platform_role_capabilities_role_id_platform_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."platform_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_role_entity_policies" ADD CONSTRAINT "platform_role_entity_policies_role_id_platform_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."platform_roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_roles" ADD CONSTRAINT "platform_roles_org_id_platform_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."platform_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_capability_overrides" ADD CONSTRAINT "platform_user_capability_overrides_org_id_platform_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."platform_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_capability_overrides" ADD CONSTRAINT "platform_user_capability_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_entity_policy_overrides" ADD CONSTRAINT "platform_user_entity_policy_overrides_org_id_platform_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."platform_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_entity_policy_overrides" ADD CONSTRAINT "platform_user_entity_policy_overrides_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_workbench_preferences" ADD CONSTRAINT "platform_user_workbench_preferences_org_id_platform_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."platform_organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_user_workbench_preferences" ADD CONSTRAINT "platform_user_workbench_preferences_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_oauth_authorization_codes" ADD CONSTRAINT "platform_oauth_authorization_codes_grant_id_platform_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."platform_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_oauth_authorization_codes" ADD CONSTRAINT "platform_oauth_authorization_codes_client_id_platform_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."platform_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_oauth_clients" ADD CONSTRAINT "platform_oauth_clients_bound_user_id_users_id_fk" FOREIGN KEY ("bound_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_oauth_grants" ADD CONSTRAINT "platform_oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_oauth_grants" ADD CONSTRAINT "platform_oauth_grants_client_id_platform_oauth_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."platform_oauth_clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_oauth_tokens" ADD CONSTRAINT "platform_oauth_tokens_grant_id_platform_oauth_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."platform_oauth_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD CONSTRAINT "table_automation_outbox_rule_id_table_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."table_automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_automation_outbox" ADD CONSTRAINT "table_automation_outbox_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_automation_rules" ADD CONSTRAINT "table_automation_rules_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_automation_rules" ADD CONSTRAINT "table_automation_rules_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_automation_runs" ADD CONSTRAINT "table_automation_runs_rule_id_table_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."table_automation_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_automation_runs" ADD CONSTRAINT "table_automation_runs_outbox_id_table_automation_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."table_automation_outbox"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_base_members" ADD CONSTRAINT "table_base_members_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_dashboard_widgets" ADD CONSTRAINT "table_dashboard_widgets_dashboard_id_table_dashboards_id_fk" FOREIGN KEY ("dashboard_id") REFERENCES "public"."table_dashboards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_dashboard_widgets" ADD CONSTRAINT "table_dashboard_widgets_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_dashboards" ADD CONSTRAINT "table_dashboards_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_field_dependencies" ADD CONSTRAINT "table_field_dependencies_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_field_dependencies" ADD CONSTRAINT "table_field_dependencies_depends_on_field_id_table_fields_id_fk" FOREIGN KEY ("depends_on_field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_fields" ADD CONSTRAINT "table_fields_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_forms" ADD CONSTRAINT "table_forms_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_notifications" ADD CONSTRAINT "table_notifications_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_notifications" ADD CONSTRAINT "table_notifications_rule_id_table_automation_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."table_automation_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_notifications" ADD CONSTRAINT "table_notifications_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_recompute_jobs" ADD CONSTRAINT "table_recompute_jobs_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_attachments" ADD CONSTRAINT "table_record_attachments_record_id_table_records_id_fk" FOREIGN KEY ("record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_attachments" ADD CONSTRAINT "table_record_attachments_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_attachments" ADD CONSTRAINT "table_record_attachments_drive_file_id_drive_files_id_fk" FOREIGN KEY ("drive_file_id") REFERENCES "public"."drive_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_field_id_table_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."table_fields"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_source_record_id_table_records_id_fk" FOREIGN KEY ("source_record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_record_links" ADD CONSTRAINT "table_record_links_target_record_id_table_records_id_fk" FOREIGN KEY ("target_record_id") REFERENCES "public"."table_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_records" ADD CONSTRAINT "table_records_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_schema_versions" ADD CONSTRAINT "table_schema_versions_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_tables" ADD CONSTRAINT "table_tables_base_id_table_bases_id_fk" FOREIGN KEY ("base_id") REFERENCES "public"."table_bases"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "table_views" ADD CONSTRAINT "table_views_table_id_table_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."table_tables"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_gates" ADD CONSTRAINT "workflow_gates_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_node_runs" ADD CONSTRAINT "workflow_node_runs_run_id_workflow_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_workflow_id_workflows_id_fk" FOREIGN KEY ("workflow_id") REFERENCES "public"."workflows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflows" ADD CONSTRAINT "workflows_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_artifacts" ADD CONSTRAINT "agent_artifacts_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_approvals" ADD CONSTRAINT "agent_run_approvals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_approvals" ADD CONSTRAINT "agent_run_approvals_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_approvals" ADD CONSTRAINT "agent_run_approvals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_events" ADD CONSTRAINT "agent_run_events_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_run_outbox" ADD CONSTRAINT "agent_run_outbox_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_workspace_id_agent_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."agent_workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspaces" ADD CONSTRAINT "agent_workspaces_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_artifacts" ADD CONSTRAINT "runtime_artifacts_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_artifacts" ADD CONSTRAINT "runtime_artifacts_step_id_runtime_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."runtime_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_artifacts" ADD CONSTRAINT "runtime_artifacts_tool_call_id_runtime_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."runtime_tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_events" ADD CONSTRAINT "runtime_events_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_interrupts" ADD CONSTRAINT "runtime_interrupts_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_interrupts" ADD CONSTRAINT "runtime_interrupts_step_id_runtime_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."runtime_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_interrupts" ADD CONSTRAINT "runtime_interrupts_tool_call_id_runtime_tool_calls_id_fk" FOREIGN KEY ("tool_call_id") REFERENCES "public"."runtime_tool_calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_outbox" ADD CONSTRAINT "runtime_outbox_event_id_runtime_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."runtime_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_runs" ADD CONSTRAINT "runtime_runs_parent_run_id_runtime_runs_id_fk" FOREIGN KEY ("parent_run_id") REFERENCES "public"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_steps" ADD CONSTRAINT "runtime_steps_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_steps" ADD CONSTRAINT "runtime_steps_parent_step_id_runtime_steps_id_fk" FOREIGN KEY ("parent_step_id") REFERENCES "public"."runtime_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_tool_calls" ADD CONSTRAINT "runtime_tool_calls_run_id_runtime_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runtime_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_tool_calls" ADD CONSTRAINT "runtime_tool_calls_step_id_runtime_steps_id_fk" FOREIGN KEY ("step_id") REFERENCES "public"."runtime_steps"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_notification_id_notifications_id_fk" FOREIGN KEY ("notification_id") REFERENCES "public"."notifications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_chat_artifact_receipts_session" ON "chat_artifact_receipts" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_chat_artifact_receipts_user" ON "chat_artifact_receipts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_chat_files_storage_key" ON "chat_files" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "idx_chat_files_session" ON "chat_files" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_chat_files_created_by" ON "chat_files" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_eval_results_run" ON "eval_results" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_eval_results_dataset" ON "eval_results" USING btree ("dataset_id");--> statement-breakpoint
CREATE INDEX "idx_chat_eval_message" ON "chat_eval_results" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "idx_chat_eval_session" ON "chat_eval_results" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_budget_account_scope_period" ON "usage_budget_accounts" USING btree ("scope_type","scope_id","unit","period_start","period_end");--> statement-breakpoint
CREATE INDEX "idx_usage_budget_accounts_scope" ON "usage_budget_accounts" USING btree ("scope_type","scope_id","status");--> statement-breakpoint
CREATE INDEX "idx_usage_budget_accounts_period" ON "usage_budget_accounts" USING btree ("period_start","period_end");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_budget_ledger_account_operation" ON "usage_budget_ledger" USING btree ("account_id","operation_key");--> statement-breakpoint
CREATE INDEX "idx_usage_budget_ledger_account_created" ON "usage_budget_ledger" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_budget_ledger_reservation" ON "usage_budget_ledger" USING btree ("reservation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_usage_budget_reservation_account_key" ON "usage_budget_reservations" USING btree ("account_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_usage_budget_reservations_key" ON "usage_budget_reservations" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_usage_budget_reservations_status_expiry" ON "usage_budget_reservations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "idx_usage_budget_reservations_user_created" ON "usage_budget_reservations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_usage_budget_reservations_run" ON "usage_budget_reservations" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_account_password_links_token_hash" ON "account_password_links" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_account_password_links_current_user" ON "account_password_links" USING btree ("user_id") WHERE "account_password_links"."consumed_at" IS NULL AND "account_password_links"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_account_password_links_user_created" ON "account_password_links" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_account_password_links_expires" ON "account_password_links" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_runtime_occurrences_task" ON "scheduled_task_runtime_occurrences" USING btree ("task_id","run_created_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_task_runtime_occurrences_owner" ON "scheduled_task_runtime_occurrences" USING btree ("owner_user_id","projected_at");--> statement-breakpoint
CREATE INDEX "idx_provider_tokens_user" ON "user_provider_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_provider_tokens_provider" ON "user_provider_tokens" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "idx_feishu_conversations_user" ON "feishu_conversations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_feishu_receipts_received" ON "feishu_message_receipts" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "idx_custom_profile_versions_profile_hash" ON "custom_profile_versions" USING btree ("profile_id","manifest_hash");--> statement-breakpoint
CREATE INDEX "idx_custom_profile_versions_profile" ON "custom_profile_versions" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_custom_profile_versions_created" ON "custom_profile_versions" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_kb_comments_doc" ON "kb_comments" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_kb_comments_created" ON "kb_comments" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_links_from_to" ON "kb_links" USING btree ("from_doc_id","to_doc_id");--> statement-breakpoint
CREATE INDEX "idx_kb_links_to" ON "kb_links" USING btree ("to_doc_id");--> statement-breakpoint
CREATE INDEX "idx_kb_links_from" ON "kb_links" USING btree ("from_doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_drive_files_cos_key" ON "drive_files" USING btree ("cos_key");--> statement-breakpoint
CREATE INDEX "idx_drive_files_folder" ON "drive_files" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_drive_files_kb" ON "drive_files" USING btree ("scope","visibility","owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_drive_files_tables" ON "drive_files" USING btree ("scope","base_id");--> statement-breakpoint
CREATE INDEX "idx_drive_files_status" ON "drive_files" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_drive_folders_parent" ON "drive_folders" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_drive_folders_kb" ON "drive_folders" USING btree ("scope","visibility","owner_user_id");--> statement-breakpoint
CREATE INDEX "idx_drive_folders_tables" ON "drive_folders" USING btree ("scope","base_id");--> statement-breakpoint
CREATE INDEX "idx_email_send_log_user_time" ON "email_send_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_email_send_log_scope_time" ON "email_send_log" USING btree ("account_scope","created_at");--> statement-breakpoint
CREATE INDEX "idx_tool_frictions_status" ON "tool_frictions" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_tool_frictions_tool" ON "tool_frictions" USING btree ("tool_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_app_releases_version" ON "platform_app_releases" USING btree ("app_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_app_releases_active" ON "platform_app_releases" USING btree ("app_id") WHERE "platform_app_releases"."status" = 'active';--> statement-breakpoint
CREATE INDEX "idx_platform_app_releases_status" ON "platform_app_releases" USING btree ("app_id","status");--> statement-breakpoint
CREATE INDEX "idx_platform_audit_org_created" ON "platform_audit_events" USING btree ("org_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_platform_audit_actor_created" ON "platform_audit_events" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_platform_audit_resource_created" ON "platform_audit_events" USING btree ("app_id","entity_id","record_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_platform_audit_request" ON "platform_audit_events" USING btree ("request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_organizations_code" ON "platform_organizations" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_platform_organizations_status" ON "platform_organizations" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_platform_role_bindings_user" ON "platform_role_bindings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_platform_role_capabilities_capability" ON "platform_role_capabilities" USING btree ("capability");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_role_entity_policy" ON "platform_role_entity_policies" USING btree ("role_id","app_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_platform_role_entity_policy_resource" ON "platform_role_entity_policies" USING btree ("app_id","module_id","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_roles_org_code" ON "platform_roles" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "idx_platform_roles_org_status" ON "platform_roles" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "idx_platform_user_capability_user" ON "platform_user_capability_overrides" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "idx_platform_user_capability_capability" ON "platform_user_capability_overrides" USING btree ("capability");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_user_entity_policy" ON "platform_user_entity_policy_overrides" USING btree ("org_id","user_id","app_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_platform_user_entity_policy_resource" ON "platform_user_entity_policy_overrides" USING btree ("app_id","module_id","entity_id");--> statement-breakpoint
CREATE INDEX "idx_platform_workbench_preferences_user" ON "platform_user_workbench_preferences" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_platform_oauth_codes_grant" ON "platform_oauth_authorization_codes" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_platform_oauth_codes_expiry" ON "platform_oauth_authorization_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_platform_oauth_clients_status" ON "platform_oauth_clients" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_oauth_grants_principal" ON "platform_oauth_grants" USING btree ("user_id","client_id","resource");--> statement-breakpoint
CREATE INDEX "idx_platform_oauth_grants_user_status" ON "platform_oauth_grants" USING btree ("user_id","status","updated_at");--> statement-breakpoint
CREATE INDEX "idx_platform_oauth_grants_client" ON "platform_oauth_grants" USING btree ("client_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_platform_oauth_tokens_hash" ON "platform_oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_platform_oauth_tokens_grant_type" ON "platform_oauth_tokens" USING btree ("grant_id","token_type");--> statement-breakpoint
CREATE INDEX "idx_platform_oauth_tokens_expiry" ON "platform_oauth_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_automation_outbox_idempotency" ON "table_automation_outbox" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_table_automation_outbox_status" ON "table_automation_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_automation_rules_base_name" ON "table_automation_rules" USING btree ("base_id","name");--> statement-breakpoint
CREATE INDEX "idx_table_automation_rules_trigger" ON "table_automation_rules" USING btree ("table_id","status","trigger");--> statement-breakpoint
CREATE INDEX "idx_table_automation_runs_rule" ON "table_automation_runs" USING btree ("rule_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_table_automation_runs_status" ON "table_automation_runs" USING btree ("status","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_base_members_base_user" ON "table_base_members" USING btree ("base_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_table_base_members_user" ON "table_base_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_table_bases_owner" ON "table_bases" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_table_bases_visibility" ON "table_bases" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "idx_table_bases_updated" ON "table_bases" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "idx_table_dashboard_widgets_dashboard" ON "table_dashboard_widgets" USING btree ("dashboard_id","position");--> statement-breakpoint
CREATE INDEX "idx_table_dashboard_widgets_table" ON "table_dashboard_widgets" USING btree ("table_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_dashboards_base_name" ON "table_dashboards" USING btree ("base_id","name");--> statement-breakpoint
CREATE INDEX "idx_table_dashboards_base" ON "table_dashboards" USING btree ("base_id");--> statement-breakpoint
CREATE INDEX "idx_table_field_dependencies_source" ON "table_field_dependencies" USING btree ("depends_on_field_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_fields_table_name" ON "table_fields" USING btree ("table_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_fields_primary" ON "table_fields" USING btree ("table_id") WHERE "table_fields"."is_primary" = true AND "table_fields"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "idx_table_fields_table_position" ON "table_fields" USING btree ("table_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_forms_table_name" ON "table_forms" USING btree ("table_id","name");--> statement-breakpoint
CREATE INDEX "idx_table_forms_table_status" ON "table_forms" USING btree ("table_id","status");--> statement-breakpoint
CREATE INDEX "idx_table_notifications_user" ON "table_notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_table_notifications_base" ON "table_notifications" USING btree ("base_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_recompute_jobs_idempotency" ON "table_recompute_jobs" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "idx_table_recompute_jobs_status" ON "table_recompute_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_record_attachments_record_field_file" ON "table_record_attachments" USING btree ("record_id","field_id","drive_file_id");--> statement-breakpoint
CREATE INDEX "idx_table_record_attachments_record" ON "table_record_attachments" USING btree ("record_id","field_id","position");--> statement-breakpoint
CREATE INDEX "idx_table_record_attachments_file" ON "table_record_attachments" USING btree ("drive_file_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_record_links_field_source_target" ON "table_record_links" USING btree ("field_id","source_record_id","target_record_id");--> statement-breakpoint
CREATE INDEX "idx_table_record_links_source" ON "table_record_links" USING btree ("field_id","source_record_id","position");--> statement-breakpoint
CREATE INDEX "idx_table_record_links_target" ON "table_record_links" USING btree ("field_id","target_record_id");--> statement-breakpoint
CREATE INDEX "idx_table_records_table_id" ON "table_records" USING btree ("table_id","id");--> statement-breakpoint
CREATE INDEX "idx_table_records_table_updated" ON "table_records" USING btree ("table_id","updated_at");--> statement-breakpoint
CREATE INDEX "idx_table_records_deleted" ON "table_records" USING btree ("table_id","deleted_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_schema_versions_table_version" ON "table_schema_versions" USING btree ("table_id","version");--> statement-breakpoint
CREATE INDEX "idx_table_schema_versions_table_created" ON "table_schema_versions" USING btree ("table_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_table_tables_base_name" ON "table_tables" USING btree ("base_id","name");--> statement-breakpoint
CREATE INDEX "idx_table_tables_base_position" ON "table_tables" USING btree ("base_id","position");--> statement-breakpoint
CREATE INDEX "idx_table_views_table_position" ON "table_views" USING btree ("table_id","position");--> statement-breakpoint
CREATE INDEX "idx_table_views_owner" ON "table_views" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_gates_run" ON "workflow_gates" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_gates_status" ON "workflow_gates" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workflow_node_runs_run" ON "workflow_node_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_node_runs_run_node" ON "workflow_node_runs" USING btree ("run_id","node_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_workflow" ON "workflow_runs" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_user" ON "workflow_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_workflow_runs_status" ON "workflow_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_workflows_user" ON "workflows" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_artifacts_run" ON "agent_artifacts" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_agent_run_approvals_run_status" ON "agent_run_approvals" USING btree ("run_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_run_approvals_user_status" ON "agent_run_approvals" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_run_events_run_seq" ON "agent_run_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "idx_agent_run_events_run" ON "agent_run_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_agent_run_outbox_status" ON "agent_run_outbox" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_user" ON "agent_runs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_status" ON "agent_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_workspace" ON "agent_runs" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_agent_runs_session" ON "agent_runs" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_agent_runs_dispatch" ON "agent_runs" USING btree ("dispatch_id");--> statement-breakpoint
CREATE INDEX "idx_agent_workspaces_user" ON "agent_workspaces" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_artifacts_run_created" ON "runtime_artifacts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_artifacts_step" ON "runtime_artifacts" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_artifacts_tool" ON "runtime_artifacts" USING btree ("tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_events_run_seq" ON "runtime_events" USING btree ("run_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_events_run_idempotency" ON "runtime_events" USING btree ("run_id","idempotency_key") WHERE "runtime_events"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runtime_events_run_created" ON "runtime_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_events_step" ON "runtime_events" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_interrupts_run_created" ON "runtime_interrupts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_interrupts_assignee_pending" ON "runtime_interrupts" USING btree ("assignee_user_id","status","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_interrupts_step" ON "runtime_interrupts" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_interrupts_tool" ON "runtime_interrupts" USING btree ("tool_call_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_outbox_event_topic" ON "runtime_outbox" USING btree ("event_id","topic");--> statement-breakpoint
CREATE INDEX "idx_runtime_outbox_delivery" ON "runtime_outbox" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_runs_source" ON "runtime_runs" USING btree ("kind","source_kind","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_runs_owner_idempotency" ON "runtime_runs" USING btree ("owner_user_id","kind","idempotency_key") WHERE "runtime_runs"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_runtime_runs_owner_created" ON "runtime_runs" USING btree ("owner_user_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_runs_root" ON "runtime_runs" USING btree ("root_run_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_runs_parent" ON "runtime_runs" USING btree ("parent_run_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_runs_claim" ON "runtime_runs" USING btree ("status","desired_state","not_before","priority");--> statement-breakpoint
CREATE INDEX "idx_runtime_runs_stale_lease" ON "runtime_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_steps_run_key_attempt" ON "runtime_steps" USING btree ("run_id","step_key","attempt");--> statement-breakpoint
CREATE INDEX "idx_runtime_steps_run_created" ON "runtime_steps" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_steps_parent" ON "runtime_steps" USING btree ("parent_step_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_steps_claim" ON "runtime_steps" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_tool_calls_run_created" ON "runtime_tool_calls" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_runtime_tool_calls_step" ON "runtime_tool_calls" USING btree ("step_id");--> statement-breakpoint
CREATE INDEX "idx_runtime_tool_calls_interrupt" ON "runtime_tool_calls" USING btree ("interrupt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_runtime_tool_calls_run_idempotency" ON "runtime_tool_calls" USING btree ("run_id","idempotency_key") WHERE "runtime_tool_calls"."idempotency_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notification_delivery_channel_recipient" ON "notification_delivery_attempts" USING btree ("notification_id","channel","recipient");--> statement-breakpoint
CREATE INDEX "idx_notification_delivery_claim" ON "notification_delivery_attempts" USING btree ("status","available_at","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_notifications_user_dedupe" ON "notifications" USING btree ("user_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "idx_notifications_user_unread_created" ON "notifications" USING btree ("user_id","read_at","created_at");--> statement-breakpoint
CREATE INDEX "idx_notifications_run" ON "notifications" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_interrupt" ON "notifications" USING btree ("interrupt_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_event" ON "notifications" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "idx_notifications_agent" ON "notifications" USING btree ("agent_id");--> statement-breakpoint
ALTER TABLE "api_clients" ADD CONSTRAINT "api_clients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
DELETE FROM "session_shares" ss WHERE NOT EXISTS (SELECT 1 FROM "sessions" s WHERE s."id" = ss."session_id");--> statement-breakpoint
DELETE FROM "session_share_reads" ssr WHERE NOT EXISTS (SELECT 1 FROM "sessions" s WHERE s."id" = ssr."session_id");--> statement-breakpoint
ALTER TABLE "session_share_reads" ADD CONSTRAINT "session_share_reads_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_shares" ADD CONSTRAINT "session_shares_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD CONSTRAINT "custom_profiles_owner_backup_user_id_users_id_fk" FOREIGN KEY ("owner_backup_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_folder_id_drive_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."drive_folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_superseded_by_user_memories_id_fk" FOREIGN KEY ("superseded_by") REFERENCES "public"."user_memories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Renumber every transcript into one deterministic order before enforcing
-- (session_id, seq) uniqueness.
WITH "ranked_messages" AS (
  SELECT
    "id",
    (ROW_NUMBER() OVER (
      PARTITION BY "session_id"
      ORDER BY "seq", "created_at", "id"
    ) - 1)::integer AS "new_seq"
  FROM "messages"
)
UPDATE "messages"
SET "seq" = "ranked_messages"."new_seq"
FROM "ranked_messages"
WHERE "messages"."id" = "ranked_messages"."id"
  AND "messages"."seq" IS DISTINCT FROM "ranked_messages"."new_seq";--> statement-breakpoint
CREATE UNIQUE INDEX "uq_messages_session_seq" ON "messages" USING btree ("session_id","seq");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_budget_key" ON "llm_usage" USING btree ("budget_idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_prompts_artifact_action" ON "user_prompts" USING btree ("artifact_action_id");--> statement-breakpoint
CREATE INDEX "idx_custom_profiles_lifecycle" ON "custom_profiles" USING btree ("lifecycle_status");--> statement-breakpoint
CREATE INDEX "idx_custom_profiles_backup_owner" ON "custom_profiles" USING btree ("owner_backup_user_id");--> statement-breakpoint
CREATE INDEX "idx_kb_folder" ON "knowledge_base" USING btree ("folder_id");--> statement-breakpoint
CREATE INDEX "idx_user_memories_status" ON "user_memories" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_agent_skills_scan_status" ON "agent_skills" USING btree ("scan_status");--> statement-breakpoint
-- Explicit tool grants saved under retired ids move to their successors.
INSERT INTO "user_tools" ("user_id", "tool_id", "assigned_by", "assigned_at")
SELECT ut."user_id", 'knowledge_query', ut."assigned_by", ut."assigned_at"
FROM "user_tools" ut
WHERE ut."tool_id" = 'team_knowledge'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "user_tools" ("user_id", "tool_id", "assigned_by", "assigned_at")
SELECT ut."user_id", 'knowledge_query', ut."assigned_by", ut."assigned_at"
FROM "user_tools" ut
WHERE ut."tool_id" = 'personal_knowledge'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "user_tools" ("user_id", "tool_id", "assigned_by", "assigned_at")
SELECT ut."user_id", 'project_query', ut."assigned_by", ut."assigned_at"
FROM "user_tools" ut
WHERE ut."tool_id" = 'project_manager'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "user_tools" ("user_id", "tool_id", "assigned_by", "assigned_at")
SELECT ut."user_id", 'project_mutation', ut."assigned_by", ut."assigned_at"
FROM "user_tools" ut
WHERE ut."tool_id" = 'project_manager'
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "user_tools" ("user_id", "tool_id", "assigned_by", "assigned_at")
SELECT ut."user_id", 'session_query', ut."assigned_by", ut."assigned_at"
FROM "user_tools" ut
WHERE ut."tool_id" = 'session_history'
ON CONFLICT DO NOTHING;--> statement-breakpoint
DELETE FROM "user_tools" WHERE "tool_id" IN ('team_knowledge', 'personal_knowledge', 'project_manager', 'session_history');--> statement-breakpoint
-- A schedule whose owner can no longer sign in must not keep running.
UPDATE "scheduled_tasks" AS "task"
SET "enabled" = false, "next_run_at" = NULL, "updated_at" = NOW()
WHERE "task"."enabled" = true
  AND NOT EXISTS (
    SELECT 1 FROM "users" AS "owner"
    WHERE "owner"."id" = "task"."user_id" AND "owner"."status" IN ('active', 'reset_required')
  );--> statement-breakpoint
ALTER TABLE "api_audit_log" DROP COLUMN "session_id";--> statement-breakpoint
ALTER TABLE "api_audit_log" DROP COLUMN "ext_user_id";--> statement-breakpoint
ALTER TABLE "api_audit_log" DROP COLUMN "a2a_task_id";--> statement-breakpoint
ALTER TABLE "api_clients" DROP COLUMN "allowed_profiles";--> statement-breakpoint
ALTER TABLE "session_shares" DROP COLUMN "read_at";--> statement-breakpoint
ALTER TABLE "custom_profiles" DROP COLUMN "data";--> statement-breakpoint
ALTER TABLE "user_memories" DROP COLUMN "confidence";--> statement-breakpoint
ALTER TABLE "user_memories" DROP COLUMN "access_count";--> statement-breakpoint
ALTER TABLE "user_memories" DROP COLUMN "last_accessed_at";--> statement-breakpoint