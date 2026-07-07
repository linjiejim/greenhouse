import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@greenhouse/types/api': resolve(__dirname, 'packages/types/src/api.ts'),
      '@greenhouse/types/session': resolve(__dirname, 'packages/types/src/session.ts'),
      '@greenhouse/types/eval': resolve(__dirname, 'packages/types/src/eval.ts'),
      '@greenhouse/types/http-client': resolve(__dirname, 'packages/types/src/http-client.ts'),
      '@greenhouse/types/agent-context': resolve(__dirname, 'packages/types/src/agent-context.ts'),
      '@greenhouse/types/features': resolve(__dirname, 'packages/types/src/features.ts'),
      '@greenhouse/types/profile-manifest': resolve(__dirname, 'packages/types/src/profile-manifest.ts'),
      '@greenhouse/types': resolve(__dirname, 'packages/types/src/index.ts'),
      '@greenhouse/utils/date': resolve(__dirname, 'packages/utils/src/date.ts'),
      '@greenhouse/utils/json': resolve(__dirname, 'packages/utils/src/json.ts'),
      '@greenhouse/utils/concurrency': resolve(__dirname, 'packages/utils/src/concurrency.ts'),
      '@greenhouse/utils/logger': resolve(__dirname, 'packages/utils/src/logger.ts'),
      '@greenhouse/utils/crypto': resolve(__dirname, 'packages/utils/src/crypto.ts'),
      '@greenhouse/utils/error': resolve(__dirname, 'packages/utils/src/error.ts'),
      '@greenhouse/utils/prompts': resolve(__dirname, 'packages/utils/src/prompts.ts'),
      '@greenhouse/utils/id': resolve(__dirname, 'packages/utils/src/id.ts'),
      '@greenhouse/utils/version': resolve(__dirname, 'packages/utils/src/version.ts'),
      '@greenhouse/utils/semver': resolve(__dirname, 'packages/utils/src/semver.ts'),
      '@greenhouse/utils': resolve(__dirname, 'packages/utils/src/index.ts'),
      '@greenhouse/db/interfaces': resolve(__dirname, 'packages/db/src/interfaces.ts'),
      '@greenhouse/db/schema': resolve(__dirname, 'packages/db/src/schema/index.ts'),
      '@greenhouse/db/seeds/eval-seed': resolve(__dirname, 'packages/db/src/seeds/eval-seed.ts'),
      '@greenhouse/db': resolve(__dirname, 'packages/db/src/index.ts'),
      '@greenhouse/agent-core': resolve(__dirname, 'packages/agent-core/src/index.ts'),
      '@greenhouse/ui': resolve(__dirname, 'packages/ui/src'),
      '@greenhouse/knowledge-editor/extensions': resolve(__dirname, 'packages/knowledge-editor/src/extensions.ts'),
      '@greenhouse/knowledge-editor/markdown': resolve(__dirname, 'packages/knowledge-editor/src/markdown.ts'),
      '@greenhouse/knowledge-editor/serialize': resolve(__dirname, 'packages/knowledge-editor/src/serialize.ts'),
    },
  },
  test: {
    globals: true,
    // tests/e2e = API e2e suite (own config, needs a running API); tests/e2e-ui =
    // Playwright browser suite (run via `pnpm test:e2e:ui`). Neither belongs to the
    // default vitest run — collecting a Playwright spec throws at import.
    exclude: ['tests/e2e/**', 'tests/e2e-ui/**', '**/node_modules/**'],
    // Silence app loggers so error-path tests don't spam the run output.
    // Override with LOG_LEVEL=debug when debugging a specific test.
    env: { LOG_LEVEL: process.env.LOG_LEVEL ?? 'silent' },
    // DB integration tests share a single greenhouse_test database;
    // parallel workers can reset schema while another file is asserting.
    fileParallelism: false,
    minWorkers: 1,
    maxWorkers: 1,
    maxConcurrency: 1,
    sequence: { concurrent: false },
  },
});
