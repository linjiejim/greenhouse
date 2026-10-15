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

// Vitest 3 owns one fork pool across projects. Worker limits inside a project
// are ignored; keep legacy env names as aliases for the shared pool limit.
const workers = positiveWorkerCount(
  process.env.VITEST_MAX_WORKERS ?? process.env.VITEST_UNIT_MAX_WORKERS ?? process.env.VITEST_DB_MAX_WORKERS,
  3,
  'VITEST_MAX_WORKERS',
);

export default defineConfig({
  resolve: {
    alias: {
      '@greenhouse/types/plant-avatar': resolve(__dirname, 'packages/types/src/plant-avatar.ts'),
      '@greenhouse/types/agent-templates': resolve(__dirname, 'packages/types/src/agent-templates.ts'),
      '@greenhouse/types/config': resolve(__dirname, 'packages/types/src/config.ts'),
      '@greenhouse/types/config-schema': resolve(__dirname, 'packages/types/src/config-schema.ts'),
      '@greenhouse/types/rich-output': resolve(__dirname, 'packages/types/src/rich-output.ts'),
      '@greenhouse/types/profile-manifest': resolve(__dirname, 'packages/types/src/profile-manifest.ts'),
      '@greenhouse/types/entity-links': resolve(__dirname, 'packages/types/src/entity-links.ts'),
      '@greenhouse/types': resolve(__dirname, 'packages/types/src/index.ts'),
      // The more specific key first: a string alias also matches everything below it.
      '@greenhouse/ui/kit/kit.css': resolve(__dirname, 'packages/ui/src/kit/kit.css'),
      '@greenhouse/ui/kit': resolve(__dirname, 'packages/ui/src/kit/index.ts'),
      '@greenhouse/utils/date': resolve(__dirname, 'packages/utils/src/date.ts'),
      '@greenhouse/utils/brand': resolve(__dirname, 'packages/utils/src/brand.ts'),
      '@greenhouse/utils/json': resolve(__dirname, 'packages/utils/src/json.ts'),
      '@greenhouse/utils/concurrency': resolve(__dirname, 'packages/utils/src/concurrency.ts'),
      '@greenhouse/utils/logger': resolve(__dirname, 'packages/utils/src/logger.ts'),
      '@greenhouse/utils/crypto': resolve(__dirname, 'packages/utils/src/crypto.ts'),
      '@greenhouse/utils/error': resolve(__dirname, 'packages/utils/src/error.ts'),
      '@greenhouse/utils/prompts': resolve(__dirname, 'packages/utils/src/prompts.ts'),
      '@greenhouse/utils/semver': resolve(__dirname, 'packages/utils/src/semver.ts'),
      '@greenhouse/utils/audio': resolve(__dirname, 'packages/utils/src/audio.ts'),
      '@greenhouse/utils/html': resolve(__dirname, 'packages/utils/src/html.ts'),
      '@greenhouse/agent-core': resolve(__dirname, 'packages/agent-core/src/index.ts'),
      '@greenhouse/contract/client': resolve(__dirname, 'packages/contract/src/client.ts'),
      '@greenhouse/contract': resolve(__dirname, 'packages/contract/src/index.ts'),
      '@greenhouse/providers': resolve(__dirname, 'packages/providers/src/index.ts'),
      '@greenhouse/db/testing': resolve(__dirname, 'packages/db/src/testing.ts'),
      '@greenhouse/db': resolve(__dirname, 'packages/db/src/index.ts'),
      '@greenhouse/knowledge-editor/editor': resolve(__dirname, 'packages/knowledge-editor/src/editor.ts'),
      '@greenhouse/knowledge-editor/extensions': resolve(__dirname, 'packages/knowledge-editor/src/extensions.ts'),
      '@greenhouse/knowledge-editor/markdown': resolve(__dirname, 'packages/knowledge-editor/src/markdown.ts'),
      '@greenhouse/knowledge-editor/md-html': resolve(__dirname, 'packages/knowledge-editor/src/md-html.ts'),
      '@greenhouse/knowledge-editor/serialize': resolve(__dirname, 'packages/knowledge-editor/src/serialize.ts'),
    },
  },
  test: {
    globals: true,
    minWorkers: 1,
    maxWorkers: workers,
    // .claude/** holds agent worktrees (full repo copies) — never collect them.
    // skillhub/** ships in-bundle node:test files (*.test.mjs) that vitest
    // cannot parse; tests/skillhub/bundles.test.ts runs them via `node --test`.
    exclude: ['tests/e2e/**', 'tests/e2e-ui/**', '**/node_modules/**', '.claude/**', 'skillhub/**'],
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
            '**/*.db.test.ts',
            '**/*.db-commit.test.ts',
            'tests/e2e/**',
            'tests/e2e-ui/**',
            '**/node_modules/**',
            '.claude/**',
            'skillhub/**',
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
          sequence: { concurrent: false, groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: 'db',
          // Per-test rollbacks share singleton provider bindings and job dedupe keys.
          // Parallel files can hold those locks in opposite orders for the whole test.
          // Real concurrency belongs in db-commit; keep this fixture isolated.
          include: ['**/*.db.test.ts'],
          exclude: ['apps/mobile/**', '**/node_modules/**', '.claude/**'],
          globalSetup: ['./tests/setup/db-global.ts'],
          setupFiles: ['./tests/setup/db-transaction.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          hookTimeout: 20_000,
          sequence: { concurrent: false, groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          // Real commits on a real pool: races between processes, which a per-test transaction hides.
          name: 'db-commit',
          include: ['**/*.db-commit.test.ts'],
          exclude: ['apps/mobile/**', '**/node_modules/**', '.claude/**'],
          globalSetup: ['./tests/setup/db-global.ts'],
          setupFiles: ['./tests/setup/db-commit.ts'],
          pool: 'forks',
          // One file at a time: the engines of two files would take each other's queued jobs and runs.
          poolOptions: { forks: { singleFork: true } },
          hookTimeout: 20_000,
          sequence: { concurrent: false, groupOrder: 2 },
        },
      },
    ],
  },
});
