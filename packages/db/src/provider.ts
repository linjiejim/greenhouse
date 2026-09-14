/**
 * Database provider — assembles every domain service over one Drizzle client.
 *
 * `DatabaseProvider` is inferred from this factory; there is no handwritten
 * interface mirror. Adding a table means adding a service file and one line
 * here.
 */

import { sql } from 'drizzle-orm';
import { buildExtensionServices, extensionResetTables } from './extensions.js';
import { createExtensionMigrationRunner } from './extension-migrations.js';
import { createCoreMigrationBaseline } from './core-migrations.js';

import { createDbClient, type Db, type DbClient } from './client.js';
import { createSessionService } from './services/sessions.js';
import { createLlmCallService } from './services/llm-calls.js';
import { createEvalService } from './services/eval.js';
import { createChatEvalService } from './services/chat-eval.js';
import { createUsageService } from './services/usage.js';
import { createUsageBudgetService } from './services/usage-budget.js';
import { createUserService } from './services/users.js';
import { createUserToolService } from './services/user-tools.js';
import { createRefreshTokenService } from './services/refresh-tokens.js';
import { createAccountPasswordLinkService } from './services/account-password-links.js';
import { createFeatureRequestService } from './services/feature-requests.js';
import { createProjectService } from './services/projects.js';
import { createApiClientService } from './services/api-clients.js';
import { createApiAuditService } from './services/api-audit.js';
import { createUserPromptService } from './services/user-prompts.js';
import { createSessionShareService } from './services/session-shares.js';
import { createScheduledTaskService } from './services/scheduled-tasks.js';
import { createFeishuBotService } from './services/feishu-bot.js';
import { createProviderTokenService } from './services/provider-tokens.js';
import { createCustomProfileService } from './services/custom-profiles.js';
import { createSessionTagService } from './services/session-tags.js';
import { createSessionGroupService } from './services/session-groups.js';
import { createKnowledgeBaseService } from './services/knowledge-base.js';
import { createKnowledgeShareService } from './services/knowledge-shares.js';
import { createKbCommentService } from './services/kb-comments.js';
import { createGroupService } from './services/groups.js';
import { createUserFeatureService } from './services/user-features.js';
import { createUserMemoryService } from './services/user-memories.js';
import { createToolFrictionService } from './services/tool-frictions.js';
import { createDriveService } from './services/drive.js';
import { createEmailService } from './services/email.js';
import { createSkillService } from './services/skills.js';
import { createPlatformService } from './services/platform.js';
import { createPlatformOAuthService } from './services/platform-oauth.js';
import { createTablesService } from './services/tables.js';
import { createWorkflowService } from './services/workflows.js';
import { createChatFileService } from './services/chat-files.js';
import { createAgentRunService } from './services/agent-runs.js';
import { createChatArtifactReceiptService } from './services/chat-artifact-receipts.js';
import { createRuntimeService } from './services/runtime.js';
import { createNotificationService } from './services/notifications.js';
import { createWorkspaceSettingService } from './services/workspace-settings.js';

function createDatabaseProvider(db: Db, client: DbClient['client'] | null) {
  return {
    /** Services registered by enabled extensions, keyed by extension id (see extensions.ts). */
    extensions: buildExtensionServices(db),
    /** Extension-owned migration lane (see extension-migrations.ts). */
    extensionMigrations: createExtensionMigrationRunner(db),
    /** Seeding drizzle's own journal for an adopted database (see core-migrations.ts). */
    coreMigrationBaseline: createCoreMigrationBaseline(db),
    sessions: createSessionService(db),
    llmCalls: createLlmCallService(db),
    eval: createEvalService(db),
    chatEval: createChatEvalService(db),
    usage: createUsageService(db),
    usageBudget: createUsageBudgetService(db),
    users: createUserService(db),
    userTools: createUserToolService(db),
    refreshTokens: createRefreshTokenService(db),
    accountPasswordLinks: createAccountPasswordLinkService(db),
    featureRequests: createFeatureRequestService(db),
    projects: createProjectService(db),
    apiClients: createApiClientService(db),
    apiAudit: createApiAuditService(db),
    userPrompts: createUserPromptService(db),
    sessionShares: createSessionShareService(db),
    scheduledTasks: createScheduledTaskService(db),
    providerTokens: createProviderTokenService(db),
    feishuBot: createFeishuBotService(db),
    customProfiles: createCustomProfileService(db),
    sessionTags: createSessionTagService(db),
    sessionGroups: createSessionGroupService(db),
    knowledgeBase: createKnowledgeBaseService(db),
    knowledgeShares: createKnowledgeShareService(db),
    kbComments: createKbCommentService(db),
    groups: createGroupService(db),
    userFeatures: createUserFeatureService(db),
    userMemories: createUserMemoryService(db),
    toolFrictions: createToolFrictionService(db),
    drive: createDriveService(db),
    email: createEmailService(db),
    skills: createSkillService(db),
    platform: createPlatformService(db),
    platformOAuth: createPlatformOAuthService(db),
    tables: createTablesService(db),
    workflows: createWorkflowService(db),
    chatFiles: createChatFileService(db),
    agentRuns: createAgentRunService(db),
    chatArtifactReceipts: createChatArtifactReceiptService(db),
    runtime: createRuntimeService(db),
    notifications: createNotificationService(db),
    workspaceSettings: createWorkspaceSettingService(db),

    /** Health check — verifies DB connection is alive. */
    async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
      const start = Date.now();
      try {
        await db.execute(sql`SELECT 1`);
        return { ok: true, latencyMs: Date.now() - start };
      } catch {
        return { ok: false, latencyMs: Date.now() - start };
      }
    },

    /** Execute a raw SQL query (admin diagnostics only). */
    async executeRaw(query: ReturnType<typeof sql>): Promise<any[]> {
      const result = await db.execute(query);
      return result as any[];
    },

    async initSchema(): Promise<void> {
      // Schema DDL is owned EXCLUSIVELY by the migration chain (drizzle/*.sql,
      // applied via `npx drizzle-kit migrate` by CI and the deploy script).
      // This method only fail-fasts on an unmigrated database — it must never
      // create or alter anything. The old per-boot "shadow migration" (~640
      // lines of safeDDL CREATE/ALTER/backfills) was a second source of truth
      // that had already drifted from the real chain; removed 2026-06-10
      // (audit defect #2).
      try {
        await db.execute(sql`SELECT 1 FROM users LIMIT 0`);
      } catch {
        throw new Error('Database tables not found. Run `npx drizzle-kit migrate` to apply the schema.');
      }
    },

    async resetSchema(): Promise<void> {
      // Transaction-isolated integration tests start from one clean baseline
      // and roll every test back. Their provider deliberately has no root
      // client, so repeating this whole-database TRUNCATE would only add work.
      if (!client) return;

      // TRUNCATE is much faster than DROP+CREATE for tests.
      // Filter to only tables that exist in the current database.
      const tables = [
        ...extensionResetTables(),
        'workspace_settings',
        'notification_delivery_attempts',
        'notifications',
        'runtime_outbox',
        'runtime_events',
        'runtime_interrupts',
        'runtime_artifacts',
        'runtime_tool_calls',
        'runtime_steps',
        'runtime_runs',
        'usage_budget_ledger',
        'usage_budget_reservations',
        'usage_budget_accounts',
        'agent_run_outbox',
        'agent_run_approvals',
        'agent_artifacts',
        'agent_run_events',
        'agent_runs',
        'agent_workspaces',
        'table_dashboard_widgets',
        'table_dashboards',
        'table_notifications',
        'table_automation_runs',
        'table_automation_outbox',
        'table_automation_rules',
        'table_recompute_jobs',
        'table_record_attachments',
        'table_record_links',
        'table_records',
        'table_forms',
        'table_views',
        'table_field_dependencies',
        'table_schema_versions',
        'table_fields',
        'table_tables',
        'table_base_members',
        'table_bases',
        'workflow_gates',
        'workflow_node_runs',
        'workflow_runs',
        'workflows',
        'platform_oauth_tokens',
        'platform_oauth_authorization_codes',
        'platform_oauth_grants',
        'platform_oauth_clients',
        'platform_audit_events',
        'platform_app_releases',
        'platform_user_workbench_preferences',
        'platform_user_entity_policy_overrides',
        'platform_user_capability_overrides',
        'platform_role_entity_policies',
        'platform_role_capabilities',
        'platform_role_bindings',
        'platform_roles',
        'platform_organizations',
        'agent_skill_versions',
        'agent_skills',
        'drive_files',
        'drive_folders',
        'email_send_log',
        'email_accounts',
        'llm_calls',
        'chat_artifact_receipts',
        'user_memories',
        'tool_frictions',
        'user_features',
        'session_share_reads',
        'group_members',
        'user_groups',
        'knowledge_base_shares',
        'knowledge_base_versions',
        'knowledge_base',
        'session_group_members',
        'session_groups',
        'session_tag_links',
        'session_tags',
        'session_shares',
        'scheduled_tasks',
        'custom_profiles',
        'user_provider_tokens',
        'user_prompts',
        'api_audit_log',
        'api_clients',
        'project_activities',
        'task_comments',
        'project_members',
        'tasks',
        'projects',
        'feature_requests',
        'account_password_links',
        'refresh_tokens',
        'user_tools',
        'users',
        'llm_usage',
        'chat_eval_results',
        'eval_results',
        'eval_runs',
        'eval_datasets',
        'messages',
        'chat_files',
        'sessions',
      ];
      const rows = (await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)) as any[];
      const existingSet = new Set((rows as any[]).map((r: any) => r.tablename));
      const toTruncate = tables.filter((t) => existingSet.has(t));
      if (toTruncate.length > 0) {
        await db.execute(sql.raw(`TRUNCATE TABLE ${toTruncate.join(', ')} RESTART IDENTITY CASCADE`));
      }
    },

    async close(): Promise<void> {
      // The transaction test harness owns its reserved root connection.
      if (client) await client.end();
    },
  };
}

export function createDatabase(connectionString: string) {
  const { client, db } = createDbClient(connectionString);
  return createDatabaseProvider(db, client);
}

/** Build a provider over a transaction-scoped Drizzle client (tests only). */
export function createTestTransactionDatabase(db: Db) {
  return createDatabaseProvider(db, null);
}

export type DatabaseProvider = ReturnType<typeof createDatabase>;
