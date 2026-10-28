/** @db-commit-reason Exercises plugin retention DDL and cross-provider job claims. */
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { createDatabase, type DatabaseProvider } from '@greenhouse/db';
import { isolatedDatabase } from '../../../../../tests/helpers/isolated-db.js';
let fixture: Awaited<ReturnType<typeof isolatedDatabase>>;
let db: DatabaseProvider;
beforeAll(async () => {
  fixture = await isolatedDatabase('contributions');
  db = createDatabase(fixture.url);
}, 30_000);

vi.stubEnv('GREENHOUSE_EXTENSIONS', 'registry-fixture');
vi.mock('../compiled.generated.js', () => ({
  COMPILED_PLUGINS: [
    {
      id: 'registry-fixture',
      name: 'Fixture',
      sdk: 2,
      core: '>=3 <5',
      resetTables: ['ext_retention_fixture'],
      retention: [{ table: 'ext_retention_fixture', column: 'recorded_at', days: 7 }],
      automationTools: [{ id: 'fixture_builtin', tier: 'assist' }],
      hubContext: [
        {
          group: 'fixture',
          description: 'Fixture context',
          toolIds: ['fixture_builtin'],
          overviewHint: 'Fixture hint',
        },
      ],
      jobs: [{ id: 'fixture-job', cron: '* * * * *', run: () => {} }],
      promptContext: [{ toolIds: ['fixture_builtin'], build: async () => 'fixture context' }],
      tools: [
        {
          kind: 'lazy',
          createLazy: () => ({}),
          meta: {
            id: 'fixture_builtin',
            name: 'Fixture',
            brief: '',
            description: '',
            category: 'core',
            is_global: true,
            builtin: true,
            icon: 'Box',
            sort_order: 0,
          },
        },
      ],
      billableServices: [
        {
          service: 'computer',
          name: 'Fixture service',
          unit: 'minute',
          enabled: true,
          providers: { fixture: { provider: 'fixture', apiKeyEnv: [], price: 0.25 } },
        },
      ],
      toolAvailability: [async (id: string) => (id === 'fixture_builtin' ? 'temporarily unavailable' : null)],
      summarySources: [
        { id: 'fixture', load: async () => ({ requests: { submitted: 2, by_status: { pending: 2 }, top: [] } }) },
      ],
      settingValidators: [
        (key: string, value: string) => (key === 'fixture.key' && value === 'bad' ? 'invalid fixture' : null),
      ],
    },
  ],
}));

afterAll(async () => {
  await db.close();
  await fixture?.drop();
  vi.unstubAllEnvs();
}, 30_000);

it('aggregates a fixture into prompt, availability, billing, jobs and summaries', async () => {
  const extensions = await import('../index.js');
  const tools = await import('../../tools/registry.js');
  const prompt = await import('../prompt-context.js');
  const prices = await import('../../config/services.js');
  const availability = await import('../../agent-runtime/service-tools.js');
  const validation = await import('../../settings/validation-registry.js');
  expect(tools.BUILTIN_AGENT_TOOL_IDS.has('fixture_builtin')).toBe(true);
  const automation = await import('@greenhouse/types/automation-tools');
  expect(automation.normalizeAutomationOptInTools(['fixture_builtin'])).toEqual(['fixture_builtin']);
  expect(extensions.fromExtensions('hubContext')[0].description).toBe('Fixture context');
  expect(await prompt.resolveExtensionPromptContext('member', 'team', ['fixture_builtin'])).toBe('fixture context');
  expect(await prompt.resolveExtensionPromptContext('member', 'team', [])).toBeNull();
  expect(await availability.externalToolUnavailableMessage('fixture_builtin')).toBe('temporarily unavailable');
  expect(prices.getServiceCatalog().computer?.providers.fixture.price).toBe(0.25);
  expect(extensions.fromExtensions('jobs').map((job) => job.id)).toEqual(['fixture-job']);
  expect(await extensions.fromExtensions('summarySources')[0].load(db, { from: '', to: '' })).toMatchObject({
    requests: { submitted: 2 },
  });
  expect(validation.workspaceSettingValidators()[0]('fixture.key', 'bad')).toBe('invalid fixture');
});

it('deletes only expired plugin rows in bounded batches and reports the count', async () => {
  await import('../index.js');
  await db.executeRaw(sql`CREATE TABLE ext_retention_fixture (recorded_at timestamptz, body text)`);
  await db.executeRaw(sql`INSERT INTO ext_retention_fixture VALUES ('2020-01-01', 'old'), ('2099-01-01', 'new')`);
  const report = await db.retention.run({ now: new Date('2026-10-27T00:00:00Z'), batchSize: 1, maxBatches: 1 });
  expect(report.ext_retention_fixture).toBe(1);
  expect(await db.executeRaw(sql`SELECT body FROM ext_retention_fixture`)).toEqual([{ body: 'new' }]);
});

it('holds a shared job lock for the full callback and releases it on failure', async () => {
  const other = createDatabase(fixture.url);
  let release!: () => void;
  let entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const key = `fixture-job:${Date.now()}`;
  try {
    const first = db.withAdvisoryLock(key, async () => {
      entered();
      await barrier;
    });
    await ready;
    expect(
      await other.withAdvisoryLock(key, async () => {
        throw new Error('must not run');
      }),
    ).toBe(false);
    release();
    expect(await first).toBe(true);
    await expect(
      db.withAdvisoryLock(key, async () => {
        throw new Error('job failed');
      }),
    ).rejects.toThrow('job failed');
    expect(await other.withAdvisoryLock(key, async () => {})).toBe(true);
  } finally {
    release();
    await other.close();
  }
});
