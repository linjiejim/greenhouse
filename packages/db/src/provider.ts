/**
 * Database provider — assembles every domain service over one Drizzle client.
 *
 * `DatabaseProvider` is inferred from this factory; there is no handwritten
 * interface mirror. Adding a table means adding a service file and one line
 * here.
 */

import { sql } from 'drizzle-orm';
import { safeJsonParse } from '@greenhouse/utils/json';

import { createDbClient } from './client.js';
import { createTableCrudService } from './crud-adapter.js';
import { crudDemoItems, type CrudDemoItemRow } from './schema/crud-demo.js';
import { createSessionService } from './services/sessions.js';
import { createLlmCallService } from './services/llm-calls.js';
import { createUsageService } from './services/usage.js';
import { createUserService } from './services/users.js';
import { createUserProfileService } from './services/user-profiles.js';
import { createUserToolService } from './services/user-tools.js';
import { createRefreshTokenService } from './services/refresh-tokens.js';
import { createFeatureRequestService } from './services/feature-requests.js';
import { createProjectService } from './services/projects.js';
import { createApiClientService } from './services/api-clients.js';
import { createApiAuditService } from './services/api-audit.js';
import { createAdminAnalyticsService } from './services/admin-analytics.js';
import { createLlmUpstreamService, createLlmGatewayModelService } from './services/llm-gateway.js';
import { createUserPromptService } from './services/user-prompts.js';
import { createSessionShareService } from './services/session-shares.js';
import { createScheduledTaskService } from './services/scheduled-tasks.js';
import { createCustomProfileService } from './services/custom-profiles.js';
import { createEmailAccountService } from './services/email-accounts.js';
import { createSessionTagService } from './services/session-tags.js';
import { createSessionGroupService } from './services/session-groups.js';
import { createKnowledgeBaseService } from './services/knowledge-base.js';
import { createKnowledgeShareService } from './services/knowledge-shares.js';
import { createGroupService } from './services/groups.js';
import { createUserFeatureService } from './services/user-features.js';
import { createUserMemoryService } from './services/user-memories.js';
import { createExtensionServices, EXTENSION_RESET_TABLES } from './extensions.js';

export function createDatabase(connectionString: string) {
  const { client, db } = createDbClient(connectionString);

  return {
    sessions: createSessionService(db),
    llmCalls: createLlmCallService(db),
    usage: createUsageService(db),
    users: createUserService(db),
    userProfiles: createUserProfileService(db),
    userTools: createUserToolService(db),
    refreshTokens: createRefreshTokenService(db),
    featureRequests: createFeatureRequestService(db),
    projects: createProjectService(db),
    apiClients: createApiClientService(db),
    apiAudit: createApiAuditService(db),
    adminAnalytics: createAdminAnalyticsService(db),
    llmUpstreams: createLlmUpstreamService(db),
    llmGatewayModels: createLlmGatewayModelService(db),
    userPrompts: createUserPromptService(db),
    sessionShares: createSessionShareService(db),
    scheduledTasks: createScheduledTaskService(db),
    customProfiles: createCustomProfileService(db),
    emailAccounts: createEmailAccountService(db),
    sessionTags: createSessionTagService(db),
    sessionGroups: createSessionGroupService(db),
    knowledgeBase: createKnowledgeBaseService(db),
    knowledgeShares: createKnowledgeShareService(db),
    groups: createGroupService(db),
    userFeatures: createUserFeatureService(db),
    userMemories: createUserMemoryService(db),

    // CRUD framework demo — reference wiring of the Drizzle adapter (see the
    // "CRUD Framework Demo" settings page). tags is a JSON string[] text column.
    crudDemo: createTableCrudService<CrudDemoItemRow>(db, crudDemoItems, {
      defaultSort: { key: 'created_at', order: 'desc' },
      writable: ['name', 'category', 'status', 'priority', 'is_featured', 'tags', 'notes'],
      transformOut: (row) => ({ ...row, tags: safeJsonParse(row.tags as string | null, []) }),
      transformIn: (data) =>
        'tags' in data ? { ...data, tags: data.tags == null ? null : JSON.stringify(data.tags) } : data,
    }),

    // Private fork services (empty upstream) — flow into the inferred
    // DatabaseProvider type. See extensions.ts.
    ...createExtensionServices(db),

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
      // TRUNCATE is much faster than DROP+CREATE for tests.
      // Filter to only tables that exist in the current database.
      const tables = [
        'crud_demo_items',
        'llm_calls',
        'user_memories',
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
        'user_prompts',
        'api_audit_log',
        'api_clients',
        'project_activities',
        'task_comments',
        'project_members',
        'tasks',
        'projects',
        'feature_requests',
        'refresh_tokens',
        'user_tools',
        'user_profiles',
        'users',
        'llm_usage',
        'messages',
        'sessions',
        // Private fork tables (empty upstream) — see extensions.ts.
        ...EXTENSION_RESET_TABLES,
      ];
      const rows = (await db.execute(sql`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)) as any[];
      const existingSet = new Set((rows as any[]).map((r: any) => r.tablename));
      const toTruncate = tables.filter((t) => existingSet.has(t));
      if (toTruncate.length > 0) {
        await db.execute(sql.raw(`TRUNCATE TABLE ${toTruncate.join(', ')} RESTART IDENTITY CASCADE`));
      }
    },

    async close(): Promise<void> {
      await client.end();
    },
  };
}

export type DatabaseProvider = ReturnType<typeof createDatabase>;
