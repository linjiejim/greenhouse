/**
 * Database provider — assembles every domain service over one Drizzle client.
 *
 * `DatabaseProvider` is inferred from this factory; there is no handwritten
 * interface mirror. Adding a table means adding a service file and one line
 * here.
 */

import { sql } from 'drizzle-orm';
import { getTableName, isTable } from 'drizzle-orm';
import * as schema from './schema/index.js';
import { buildExtensionServices, extensionResetTables } from './extensions.js';
import { createExtensionMigrationRunner } from './extension-migrations.js';
import { createCoreMigrationBaseline } from './core-migrations.js';

import { createDbClient, type Db, type DbClient } from './client.js';
import { refusalFor } from './migrate.js';
import { createSessionService } from './services/sessions.js';
import { createLlmCallService } from './services/llm-calls.js';
import { createUsageService } from './services/usage.js';
import { createUsageBudgetService } from './services/usage-budget.js';
import { createUsageCounterService } from './services/usage-counters.js';
import { createMeteringService } from './services/metering.js';
import { createUserService } from './services/users.js';
import { createUserToolService } from './services/user-tools.js';
import { createRefreshTokenService } from './services/refresh-tokens.js';
import { createAccountPasswordLinkService } from './services/account-password-links.js';
import { createProjectService } from './services/projects.js';
import { createApiAuditService } from './services/api-audit.js';
import { createUserPromptService } from './services/user-prompts.js';
import { createSessionShareService } from './services/session-shares.js';
import { createScheduledTaskService } from './services/scheduled-tasks.js';
import { createProviderTokenService } from './services/provider-tokens.js';
import { createCustomProfileService } from './services/custom-profiles.js';
import { createSessionPinService } from './services/session-pins.js';
import { createKnowledgeBaseService } from './services/knowledge-base.js';
import { createKnowledgeShareService } from './services/knowledge-shares.js';
import { createUserFeatureService } from './services/user-features.js';
import { createDriveService } from './services/drive.js';
import { createActivityService } from './services/activity.js';
import { createSkillService } from './services/skills.js';
import { createPlatformService } from './services/platform.js';
import { createPlatformOAuthService } from './services/platform-oauth.js';
import { createTablesService } from './services/tables.js';
import { createChatFileService } from './services/chat-files.js';
import { createChatArtifactReceiptService } from './services/chat-artifact-receipts.js';
import { createRuntimeService } from './services/runtime.js';
import { createNotificationService } from './services/notifications.js';
import { createPushDeviceService } from './services/push-devices.js';
import { createGatewayKeyService } from './services/gateway-keys.js';
import { createWorkspaceSettingService } from './services/workspace-settings.js';
import { createOAuthLoginStateService, createRateLimitService } from './services/security-state.js';
import { createRetentionService } from './services/retention.js';
import { createMcpConnectorService } from './services/mcp-connectors.js';

/** Every table the core schema defines, except the migration bookkeeping it must keep. */
function coreTableNames(): string[] {
  return Object.values(schema)
    .filter((value) => isTable(value))
    .map((table) => getTableName(table as Parameters<typeof getTableName>[0]))
    .filter((name) => name !== 'extension_migrations');
}

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
    usage: createUsageService(db),
    usageBudget: createUsageBudgetService(db),
    usageCounters: createUsageCounterService(db),
    metering: createMeteringService(db),
    users: createUserService(db),
    userTools: createUserToolService(db),
    refreshTokens: createRefreshTokenService(db),
    accountPasswordLinks: createAccountPasswordLinkService(db),
    projects: createProjectService(db),
    apiAudit: createApiAuditService(db),
    userPrompts: createUserPromptService(db),
    sessionShares: createSessionShareService(db),
    scheduledTasks: createScheduledTaskService(db),
    providerTokens: createProviderTokenService(db),
    customProfiles: createCustomProfileService(db),
    sessionPins: createSessionPinService(db),
    knowledgeBase: createKnowledgeBaseService(db),
    knowledgeShares: createKnowledgeShareService(db),
    userFeatures: createUserFeatureService(db),
    drive: createDriveService(db),
    activity: createActivityService(db),
    skills: createSkillService(db),
    platform: createPlatformService(db),
    platformOAuth: createPlatformOAuthService(db),
    tables: createTablesService(db),
    chatFiles: createChatFileService(db),
    chatArtifactReceipts: createChatArtifactReceiptService(db),
    runtime: createRuntimeService(db),
    notifications: createNotificationService(db),
    pushDevices: createPushDeviceService(db),
    gatewayKeys: createGatewayKeyService(db),
    workspaceSettings: createWorkspaceSettingService(db),
    rateLimits: createRateLimitService(db),
    retention: createRetentionService(db),
    oauthLoginStates: createOAuthLoginStateService(db),
    mcpConnectors: createMcpConnectorService(db),

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

    /** Hold one transaction-scoped advisory lock throughout a system job. */
    async withAdvisoryLock(key: string, run: () => Promise<void>): Promise<boolean> {
      return db.transaction(async (tx) => {
        const [row] = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext(${key})) AS acquired`);
        if (!row?.acquired) return false;
        await run();
        return true;
      });
    },

    /** Execute a raw SQL query (admin diagnostics only). */
    async executeRaw(query: ReturnType<typeof sql>): Promise<any[]> {
      const result = await db.execute(query);
      return result as any[];
    },

    async initSchema(): Promise<void> {
      // Schema DDL is owned EXCLUSIVELY by the migration chain (drizzle/*.sql,
      // applied by `pnpm db:migrate`). This method only fail-fasts — on an
      // unmigrated database, and on a 1.x / 2.x database that 3.0 must never
      // run against — and never creates or alters anything.
      const [shape] = (await db.execute(sql`
        SELECT to_regclass('public.users')::text AS users,
               to_regclass('public.members')::text AS members,
               to_regclass('public.sessions')::text AS sessions,
               to_regclass('public.conversations')::text AS conversations`)) as unknown as Array<
        Record<'users' | 'members' | 'sessions' | 'conversations', string | null>
      >;
      if (shape?.users && shape.sessions && !shape.conversations) {
        throw new Error(refusalFor({ kind: 'v1', applied: [], latest: null, current: false })!);
      }
      if (shape?.members && !shape.users) throw new Error(refusalFor({ kind: 'v2' })!);
      if (!shape?.users || !shape.conversations) {
        throw new Error('Database tables not found. Run `pnpm db:migrate` to apply the schema.');
      }
      // A migrate-from-1x carry that started here and never finished: part of the data only.
      const [carry] = (await db.execute(sql`
        SELECT to_regclass('drizzle.greenhouse_carry')::text AS marker`)) as unknown as Array<{
        marker: string | null;
      }>;
      if (carry?.marker) {
        const [state] = (await db.execute(sql`
          SELECT started_at FROM drizzle.greenhouse_carry WHERE id = 1 AND completed_at IS NULL`)) as unknown as Array<{
          started_at: string | Date;
        }>;
        if (state) {
          throw new Error(
            refusalFor({
              kind: 'carry_incomplete',
              applied: [],
              startedAt: new Date(state.started_at).toISOString(),
            })!,
          );
        }
      }
    },

    async resetSchema(): Promise<void> {
      // Transaction-isolated integration tests start from one clean baseline
      // and roll every test back. Their provider deliberately has no root
      // client, so repeating this whole-database TRUNCATE would only add work.
      if (!client) return;

      // TRUNCATE is much faster than DROP+CREATE for tests. Every core table
      // (derived from the schema, so a new table can't be forgotten) plus the
      // tables extensions registered; filtered to what exists in this database.
      const tables = [...extensionResetTables(), ...coreTableNames()];
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
