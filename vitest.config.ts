import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

function positiveWorkerCount(value: string | undefined, fallback: number, variable: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${variable} must be a positive integer, received ${JSON.stringify(value)}`);
  }
  return parsed;
}

const unitWorkers = positiveWorkerCount(
  process.env.VITEST_UNIT_MAX_WORKERS ?? process.env.VITEST_MAX_WORKERS,
  3,
  'VITEST_UNIT_MAX_WORKERS',
);
const dbWorkers = positiveWorkerCount(process.env.VITEST_DB_MAX_WORKERS, 3, 'VITEST_DB_MAX_WORKERS');

process.env.GREENHOUSE_EXTENSIONS ??= 'all';

const pluginTestExcludes = process.env.GREENHOUSE_PLUGINS?.trim() === '' ? ['plugins/**'] : [];

export default defineConfig({
  resolve: {
    alias: {
      '@greenhouse/types/api': resolve(__dirname, 'packages/types/src/api.ts'),
      '@greenhouse/types/session': resolve(__dirname, 'packages/types/src/session.ts'),
      '@greenhouse/types/source': resolve(__dirname, 'packages/types/src/source.ts'),
      '@greenhouse/types/features': resolve(__dirname, 'packages/types/src/features.ts'),
      '@greenhouse/types/config': resolve(__dirname, 'packages/types/src/config.ts'),
      '@greenhouse/types/config-schema': resolve(__dirname, 'packages/types/src/config-schema.ts'),
      '@greenhouse/types/mcp': resolve(__dirname, 'packages/types/src/mcp.ts'),
      '@greenhouse/types/connectors': resolve(__dirname, 'packages/types/src/connectors.ts'),
      '@greenhouse/types/client-routes': resolve(__dirname, 'packages/types/src/client-routes.ts'),
      '@greenhouse/types/automation-tools': resolve(__dirname, 'packages/types/src/automation-tools.ts'),
      '@greenhouse/types/tables': resolve(__dirname, 'packages/types/src/tables.ts'),
      '@greenhouse/types/object-refs': resolve(__dirname, 'packages/types/src/object-refs.ts'),
      '@greenhouse/types/rich-output': resolve(__dirname, 'packages/types/src/rich-output.ts'),
      '@greenhouse/types/tasks': resolve(__dirname, 'packages/types/src/tasks.ts'),
      '@greenhouse/types/workspace-settings': resolve(__dirname, 'packages/types/src/workspace-settings.ts'),
      '@greenhouse/types/profile-manifest': resolve(__dirname, 'packages/types/src/profile-manifest.ts'),
      '@greenhouse/types/entity-links': resolve(__dirname, 'packages/types/src/entity-links.ts'),
      '@greenhouse/types/search': resolve(__dirname, 'packages/types/src/search.ts'),
      '@greenhouse/types/notification': resolve(__dirname, 'packages/types/src/notification.ts'),
      '@greenhouse/types/push': resolve(__dirname, 'packages/types/src/push.ts'),
      '@greenhouse/types/client-reports': resolve(__dirname, 'packages/types/src/client-reports.ts'),
      '@greenhouse/types/metering': resolve(__dirname, 'packages/types/src/metering.ts'),
      '@greenhouse/types/email': resolve(__dirname, 'packages/types/src/email.ts'),
      '@greenhouse/types/discriminators': resolve(__dirname, 'packages/types/src/discriminators.ts'),
      '@greenhouse/types/runtime': resolve(__dirname, 'packages/types/src/runtime.ts'),
      '@greenhouse/types/agent-access': resolve(__dirname, 'packages/types/src/agent-access.ts'),
      '@greenhouse/types/hub-context': resolve(__dirname, 'packages/types/src/hub-context.ts'),
      '@greenhouse/types/usage': resolve(__dirname, 'packages/types/src/usage.ts'),
      '@greenhouse/types/files': resolve(__dirname, 'packages/types/src/files.ts'),
      '@greenhouse/types/reports': resolve(__dirname, 'packages/types/src/reports.ts'),
      '@greenhouse/types/preferences': resolve(__dirname, 'packages/types/src/preferences.ts'),
      '@greenhouse/types/agent-avatar': resolve(__dirname, 'packages/types/src/agent-avatar.ts'),
      '@greenhouse/types/activity': resolve(__dirname, 'packages/types/src/activity.ts'),
      '@greenhouse/types/plugins': resolve(__dirname, 'packages/types/src/plugins.ts'),
      '@greenhouse/types/plugin-host': resolve(__dirname, 'packages/types/src/plugin-host.ts'),
      '@greenhouse/types': resolve(__dirname, 'packages/types/src/index.ts'),
      '@greenhouse/utils/date': resolve(__dirname, 'packages/utils/src/date.ts'),
      '@greenhouse/utils/brand': resolve(__dirname, 'packages/utils/src/brand.ts'),
      '@greenhouse/utils/json': resolve(__dirname, 'packages/utils/src/json.ts'),
      '@greenhouse/utils/id': resolve(__dirname, 'packages/utils/src/id.ts'),
      '@greenhouse/utils/concurrency': resolve(__dirname, 'packages/utils/src/concurrency.ts'),
      '@greenhouse/utils/logger': resolve(__dirname, 'packages/utils/src/logger.ts'),
      '@greenhouse/utils/crypto': resolve(__dirname, 'packages/utils/src/crypto.ts'),
      '@greenhouse/utils/error': resolve(__dirname, 'packages/utils/src/error.ts'),
      '@greenhouse/utils/prompts': resolve(__dirname, 'packages/utils/src/prompts.ts'),
      '@greenhouse/utils/semver': resolve(__dirname, 'packages/utils/src/semver.ts'),
      '@greenhouse/utils/extension-compat': resolve(__dirname, 'packages/utils/src/extension-compat.ts'),
      '@greenhouse/utils/html': resolve(__dirname, 'packages/utils/src/html.ts'),
      '@greenhouse/db/plugin-schema': resolve(__dirname, 'packages/db/src/plugin-schema.ts'),
      '@greenhouse/db/test-config': resolve(__dirname, 'packages/db/src/test-config.ts'),
      '@greenhouse/db': resolve(__dirname, 'packages/db/src/index.ts'),
      '@greenhouse/platform-kernel/contract': resolve(__dirname, 'packages/platform-kernel/src/contract.ts'),
      '@greenhouse/platform-kernel/dsl': resolve(__dirname, 'packages/platform-kernel/src/dsl.ts'),
      '@greenhouse/platform-kernel/authz': resolve(__dirname, 'packages/platform-kernel/src/authz.ts'),
      '@greenhouse/platform-kernel/registry': resolve(__dirname, 'packages/platform-kernel/src/registry.ts'),
      '@greenhouse/platform-kernel': resolve(__dirname, 'packages/platform-kernel/src/index.ts'),
      '@greenhouse/agent-core': resolve(__dirname, 'packages/agent-core/src/index.ts'),
      '@greenhouse/knowledge-editor/extensions': resolve(__dirname, 'packages/knowledge-editor/src/extensions.ts'),
      '@greenhouse/knowledge-editor/markdown': resolve(__dirname, 'packages/knowledge-editor/src/markdown.ts'),
      '@greenhouse/knowledge-editor/md-html': resolve(__dirname, 'packages/knowledge-editor/src/md-html.ts'),
      '@greenhouse/knowledge-editor/serialize': resolve(__dirname, 'packages/knowledge-editor/src/serialize.ts'),
    },
  },
  test: {
    globals: true,
    // .claude/** holds agent worktrees (full repo copies) — never collect them.
    // skillhub/** may ship in-bundle node:test files (*.test.mjs) that vitest cannot parse.
    exclude: [
      'tests/e2e/**',
      '**/node_modules/**',
      '**/.claude/**',
      'skillhub/**',
      ...pluginTestExcludes,
      '.cargo-home/**',
      '**/target/**',
    ],
    // Silence app loggers so error-path tests don't spam the run output.
    // Override with LOG_LEVEL=debug when debugging a specific test.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['**/*.{test,spec}.{ts,tsx}'],
          exclude: [
            ...pluginTestExcludes,
            '**/*.db.test.ts',
            '**/*.db-commit.test.ts',
            'tests/e2e/**',
            '**/node_modules/**',
            '**/.claude/**',
            'skillhub/**',
            '.cargo-home/**',
            '**/target/**',
          ],
          // `forks`, not `vmThreads`, and the difference is memory, not speed.
          // A VM context is cheaper per file, but its ESM module cache is never
          // reclaimed between files, so a worker's heap only grows with however
          // many files it is handed. The ceiling on that growth is derived from
          // the machine — `1 / max(cpuCount - 1, 1)` of total RAM — so it is
          // loosest exactly where there is least memory: an 8-CPU/32 GB laptop
          // caps a worker at 4.6 GB, while a 2-CPU/7 GB CI runner caps it at the
          // whole box and runs three of them. That is why the suite passed here
          // and killed a worker there (ERR_WORKER_OUT_OF_MEMORY), naming a
          // different innocent file each run — whichever one was last onto the
          // fattest worker; each passes alone in milliseconds.
          // `poolOptions.vmThreads.memoryLimit` looks like the fix and is not:
          // it had no observable effect at either config level, verified by
          // setting a deliberately absurd 24MB and watching every jsdom render
          // test still pass. forks reclaim per file, so nothing accumulates.
          // Cost, measured: unit 17.1s -> 27.6s, full suite ~33s -> ~45s.
          pool: 'forks',
          fileParallelism: true,
          minWorkers: 1,
          maxWorkers: unitWorkers,
          sequence: { concurrent: false, groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          include: ['**/*.db.test.ts'],
          exclude: [...pluginTestExcludes, '**/node_modules/**', '**/.claude/**'],
          globalSetup: ['./tests/setup/db-global.ts'],
          setupFiles: ['./tests/setup/db-transaction.ts'],
          pool: 'forks',
          fileParallelism: true,
          minWorkers: 1,
          maxWorkers: dbWorkers,
          // Platform integration fixtures can cross Vitest's 10s default when
          // the local machine is simultaneously CPU/IO saturated. This is a
          // fail-safe, not a sleep; normal dedicated DB runs stay below it.
          hookTimeout: 20_000,
          sequence: { concurrent: false, groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'db-commit',
          include: ['**/*.db-commit.test.ts'],
          exclude: [...pluginTestExcludes, '**/node_modules/**', '**/.claude/**'],
          pool: 'forks',
          fileParallelism: false,
          maxWorkers: 1,
          sequence: { concurrent: false, groupOrder: 1 },
        },
      },
    ],
  },
});
