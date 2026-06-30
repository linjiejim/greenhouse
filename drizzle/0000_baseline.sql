CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"references_" text DEFAULT '[]' NOT NULL,
	"pipeline" text DEFAULT '[]' NOT NULL,
	"reasoning" text,
	"images" text DEFAULT '[]' NOT NULL,
	"confidence" double precision,
	"grounded" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cached_tokens" integer,
	"reasoning_tokens" integer,
	"duration_ms" integer,
	"seq" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"profile_id" text DEFAULT 'default' NOT NULL,
	"user_id" text,
	"app_id" text,
	"channel" text DEFAULT 'web' NOT NULL,
	"parent_session_id" text,
	"rating" integer,
	"comment" text,
	"feedback" text,
	"metadata" text DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_calls" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text,
	"model" text NOT NULL,
	"system" text,
	"input" text NOT NULL,
	"output" text,
	"status" text DEFAULT 'ok' NOT NULL,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_usage" (
	"id" serial PRIMARY KEY NOT NULL,
	"profile_id" text NOT NULL,
	"caller" text DEFAULT '' NOT NULL,
	"session_id" text,
	"user_id" text,
	"model" text NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cached_tokens" integer DEFAULT 0 NOT NULL,
	"reasoning_tokens" integer DEFAULT 0 NOT NULL,
	"duration_ms" integer,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_profiles" (
	"user_id" text NOT NULL,
	"profile_id" text NOT NULL,
	"assigned_by" text,
	"assigned_at" timestamp with time zone,
	CONSTRAINT "user_profiles_user_id_profile_id_pk" PRIMARY KEY("user_id","profile_id")
);
--> statement-breakpoint
CREATE TABLE "user_tools" (
	"user_id" text NOT NULL,
	"tool_id" text NOT NULL,
	"assigned_by" text,
	"assigned_at" timestamp with time zone,
	CONSTRAINT "user_tools_user_id_tool_id_pk" PRIMARY KEY("user_id","tool_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"password_hash" text NOT NULL,
	"nickname" text NOT NULL,
	"role" text DEFAULT 'team' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"daily_message_limit" integer DEFAULT 200 NOT NULL,
	"monthly_token_limit" integer DEFAULT 20000000 NOT NULL,
	"notes" text,
	"locale" text DEFAULT 'en' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"last_login_at" timestamp with time zone,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "project_activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"task_id" integer,
	"user_id" text NOT NULL,
	"action" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'planning' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"owner_id" text NOT NULL,
	"start_date" text,
	"end_date" text,
	"color" text,
	"visibility" text DEFAULT 'public' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"project_id" integer NOT NULL,
	"parent_id" integer,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'todo' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"task_type" text DEFAULT 'task' NOT NULL,
	"assignee_id" text,
	"start_date" text,
	"due_date" text,
	"completed_at" timestamp with time zone,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"estimated_hours" integer,
	"tags" text DEFAULT '[]' NOT NULL,
	"dependencies" text DEFAULT '[]' NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"method" text NOT NULL,
	"session_id" text,
	"ext_user_id" text,
	"user_id" text,
	"channel" text DEFAULT 'api' NOT NULL,
	"a2a_task_id" text,
	"status_code" integer,
	"duration_ms" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"meta" text DEFAULT '{}' NOT NULL,
	"ip_address" text,
	"error" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_clients" (
	"id" text PRIMARY KEY NOT NULL,
	"app_id" text NOT NULL,
	"app_name" text NOT NULL,
	"api_key_hash" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"allowed_profiles" text DEFAULT '[]' NOT NULL,
	"rate_limit_rpm" integer DEFAULT 60 NOT NULL,
	"rate_limit_rpd" integer DEFAULT 1000 NOT NULL,
	"daily_token_limit" integer DEFAULT 1000000 NOT NULL,
	"meta" text DEFAULT '{}' NOT NULL,
	"user_id" text,
	"channel" text DEFAULT 'api' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "api_clients_app_id_unique" UNIQUE("app_id")
);
--> statement-breakpoint
CREATE TABLE "llm_gateway_models" (
	"id" text PRIMARY KEY NOT NULL,
	"public_id" text NOT NULL,
	"display_name" text NOT NULL,
	"upstream_id" text NOT NULL,
	"upstream_model" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_public" boolean DEFAULT true NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "llm_gateway_models_public_id_unique" UNIQUE("public_id")
);
--> statement-breakpoint
CREATE TABLE "llm_upstreams" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"provider_kind" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_enc" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feature_requests" (
	"id" serial PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"submitted_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"admin_note" text,
	"session_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_prompts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"shortcut" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"is_global" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_share_reads" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"user_id" text NOT NULL,
	"read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_share_reads_session_user" UNIQUE("session_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "session_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"shared_with" text NOT NULL,
	"shared_by" text NOT NULL,
	"message" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_session_shares_session_user" UNIQUE("session_id","shared_with")
);
--> statement-breakpoint
CREATE TABLE "scheduled_tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"profile_id" text DEFAULT 'default' NOT NULL,
	"task_prompt" text NOT NULL,
	"schedule" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"max_steps" integer DEFAULT 15 NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_status" text,
	"next_run_at" timestamp with time zone,
	"run_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_profiles" (
	"id" serial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"base_profile_id" text DEFAULT 'default' NOT NULL,
	"tools" text DEFAULT '[]' NOT NULL,
	"system_prompt" text NOT NULL,
	"capabilities" text DEFAULT '[]' NOT NULL,
	"max_steps" integer DEFAULT 12 NOT NULL,
	"is_shared" boolean DEFAULT false NOT NULL,
	"avatar" text DEFAULT '{}' NOT NULL,
	"forked_from" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_custom_profiles_user_slug" UNIQUE("user_id","slug")
);
--> statement-breakpoint
CREATE TABLE "email_accounts" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"provider" text NOT NULL,
	"email_address" text NOT NULL,
	"display_name" text,
	"credentials" text NOT NULL,
	"config" text DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"error_message" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_email_accounts_user_provider_address" UNIQUE("user_id","provider","email_address")
);
--> statement-breakpoint
CREATE TABLE "session_tag_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"tag_id" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_session_tag_links" UNIQUE("session_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "session_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6B7280' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_session_tags_user_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "session_group_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"group_id" integer NOT NULL,
	"session_id" text NOT NULL,
	"kind" text DEFAULT 'custom' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_session_group_members" UNIQUE("user_id","group_id","session_id")
);
--> statement-breakpoint
CREATE TABLE "session_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"color" text DEFAULT '#6B7280' NOT NULL,
	"icon" text,
	"kind" text DEFAULT 'custom' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "uq_session_groups_user_name" UNIQUE("user_id","name")
);
--> statement-breakpoint
CREATE TABLE "knowledge_base" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" text NOT NULL,
	"scope" text DEFAULT 'shared' NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_json" text DEFAULT '{}' NOT NULL,
	"content_hash" text,
	"visibility" text DEFAULT 'team' NOT NULL,
	"status" text DEFAULT 'published' NOT NULL,
	"tags" text DEFAULT '[]' NOT NULL,
	"meta" text DEFAULT '{}' NOT NULL,
	"file_path" text,
	"owner_user_id" text,
	"created_by" text,
	"updated_by" text,
	"_summary" text DEFAULT '' NOT NULL,
	"_questions" text DEFAULT '[]' NOT NULL,
	"_topics" text DEFAULT '[]' NOT NULL,
	"_enriched_at" timestamp with time zone,
	"created_at" timestamp with time zone,
	"updated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "knowledge_base_shares" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" integer NOT NULL,
	"shared_with" text NOT NULL,
	"role" text DEFAULT 'reader' NOT NULL,
	"shared_by" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_base_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"doc_id" integer NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"content_json" text DEFAULT '{}' NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"changed_by" text,
	"change_reason" text,
	"created_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_features" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"feature" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"config" text DEFAULT '{}' NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_memories" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"category" text DEFAULT 'preference' NOT NULL,
	"content" text NOT NULL,
	"source_session_id" text,
	"confidence" double precision DEFAULT 0.8 NOT NULL,
	"access_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"group_id" integer NOT NULL,
	"user_id" text NOT NULL,
	"added_by" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_groups" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_calls" ADD CONSTRAINT "llm_calls_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_tools" ADD CONSTRAINT "user_tools_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activities" ADD CONSTRAINT "project_activities_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_activities" ADD CONSTRAINT "project_activities_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_members" ADD CONSTRAINT "project_members_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "llm_gateway_models" ADD CONSTRAINT "llm_gateway_models_upstream_id_llm_upstreams_id_fk" FOREIGN KEY ("upstream_id") REFERENCES "public"."llm_upstreams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduled_tasks" ADD CONSTRAINT "scheduled_tasks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_profiles" ADD CONSTRAINT "custom_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_accounts" ADD CONSTRAINT "email_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_tag_links" ADD CONSTRAINT "session_tag_links_tag_id_session_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."session_tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_group_members" ADD CONSTRAINT "session_group_members_group_id_session_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."session_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_group_members" ADD CONSTRAINT "session_group_members_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_shares" ADD CONSTRAINT "knowledge_base_shares_doc_id_knowledge_base_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_base_versions" ADD CONSTRAINT "knowledge_base_versions_doc_id_knowledge_base_id_fk" FOREIGN KEY ("doc_id") REFERENCES "public"."knowledge_base"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_features" ADD CONSTRAINT "user_features_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_memories" ADD CONSTRAINT "user_memories_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_user_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."user_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_messages_session" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_app_id" ON "sessions" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_sessions_channel" ON "sessions" USING btree ("channel");--> statement-breakpoint
CREATE INDEX "idx_sessions_parent" ON "sessions" USING btree ("parent_session_id");--> statement-breakpoint
CREATE INDEX "idx_llm_calls_session" ON "llm_calls" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_profile" ON "llm_usage" USING btree ("profile_id");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_created" ON "llm_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_caller" ON "llm_usage" USING btree ("caller");--> statement-breakpoint
CREATE INDEX "idx_llm_usage_user" ON "llm_usage" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_hash" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_user" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_project_activities_project" ON "project_activities" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_project_members_unique" ON "project_members" USING btree ("project_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_project_members_user" ON "project_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_projects_status" ON "projects" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_projects_owner" ON "projects" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_task_comments_task" ON "task_comments" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_project" ON "tasks" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_parent" ON "tasks" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_assignee" ON "tasks" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "idx_tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_api_audit_app" ON "api_audit_log" USING btree ("app_id");--> statement-breakpoint
CREATE INDEX "idx_api_audit_created" ON "api_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_api_audit_user" ON "api_audit_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_api_clients_user" ON "api_clients" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_gateway_models_upstream" ON "llm_gateway_models" USING btree ("upstream_id");--> statement-breakpoint
CREATE INDEX "idx_user_prompts_user" ON "user_prompts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_share_reads_user" ON "session_share_reads" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_session_shares_user" ON "session_shares" USING btree ("shared_with");--> statement-breakpoint
CREATE INDEX "idx_session_shares_session" ON "session_shares" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_session_shares_unread" ON "session_shares" USING btree ("shared_with","read_at");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_user" ON "scheduled_tasks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_enabled" ON "scheduled_tasks" USING btree ("enabled");--> statement-breakpoint
CREATE INDEX "idx_scheduled_tasks_next_run" ON "scheduled_tasks" USING btree ("next_run_at");--> statement-breakpoint
CREATE INDEX "idx_custom_profiles_user" ON "custom_profiles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_custom_profiles_shared" ON "custom_profiles" USING btree ("is_shared");--> statement-breakpoint
CREATE INDEX "idx_email_accounts_user" ON "email_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_email_accounts_user_status" ON "email_accounts" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "idx_session_tag_links_session" ON "session_tag_links" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "idx_session_tag_links_tag" ON "session_tag_links" USING btree ("tag_id");--> statement-breakpoint
CREATE INDEX "idx_session_tags_user" ON "session_tags" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_session_group_members_user" ON "session_group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_session_group_members_group" ON "session_group_members" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "idx_session_group_members_session" ON "session_group_members" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_session_group_members_single_home" ON "session_group_members" USING btree ("user_id","session_id") WHERE "session_group_members"."kind" = 'custom';--> statement-breakpoint
CREATE INDEX "idx_session_groups_user" ON "session_groups" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_doc_scope" ON "knowledge_base" USING btree ("doc_id","scope");--> statement-breakpoint
CREATE INDEX "idx_kb_scope" ON "knowledge_base" USING btree ("scope");--> statement-breakpoint
CREATE INDEX "idx_kb_visibility" ON "knowledge_base" USING btree ("visibility");--> statement-breakpoint
CREATE INDEX "idx_kb_status" ON "knowledge_base" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_kb_updated_at" ON "knowledge_base" USING btree ("updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_shares_doc_target" ON "knowledge_base_shares" USING btree ("doc_id","shared_with");--> statement-breakpoint
CREATE INDEX "idx_kb_shares_target" ON "knowledge_base_shares" USING btree ("shared_with");--> statement-breakpoint
CREATE INDEX "idx_kb_shares_doc" ON "knowledge_base_shares" USING btree ("doc_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_kb_versions_doc_version" ON "knowledge_base_versions" USING btree ("doc_id","version");--> statement-breakpoint
CREATE INDEX "idx_kb_versions_doc" ON "knowledge_base_versions" USING btree ("doc_id");--> statement-breakpoint
CREATE INDEX "idx_kb_versions_created_at" ON "knowledge_base_versions" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_user_feature" ON "user_features" USING btree ("user_id","feature");--> statement-breakpoint
CREATE INDEX "idx_user_features_feature" ON "user_features" USING btree ("feature");--> statement-breakpoint
CREATE INDEX "idx_user_memories_user" ON "user_memories" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_memories_category" ON "user_memories" USING btree ("user_id","category");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_group_members_group_user" ON "group_members" USING btree ("group_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_group_members_user" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_user_groups_creator" ON "user_groups" USING btree ("created_by");