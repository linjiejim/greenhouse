import { allActiveFrictions } from '../summary.js';
import { feedbackServices } from '../services.js';
/**
 * Monthly retro (复盘) on the real database: aggregates in, one team document
 * per month out.
 *
 * Pinned here: the doc lands in the team folder "复盘" with module usage,
 * members' agent writes by client (failed / outcome unknown), frictions,
 * feature requests and spend — and never a member's name or a private document
 * title; regenerating updates the same doc (a new version, still one folder);
 * the suggestions section is metered to the organization as client `system`,
 * and skipped with the reason when the team budget is used up or no model is
 * configured; every active super is notified with a link to the doc.
 *
 * The model is a fake (agent-core's model factory and `generateText` are
 * mocked, the budget hook is the real one).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../tests/helpers/internal-user.js';

vi.setConfig({ testTimeout: 20_000 });

const fake = vi.hoisted(() => ({
  modelAvailable: true,
  hook: undefined as undefined | ((input: any) => Promise<any>),
  prompts: [] as string[],
}));

vi.mock('@greenhouse/agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/agent-core')>();
  return {
    ...actual,
    getAvailableProviders: (id: string) => (fake.modelAvailable ? [{ id }] : []),
    resolveModelConfig: (model: unknown) => model,
    createModelFromConfig: vi.fn(
      async (_config: unknown, options?: { onProviderAttempt?: (input: any) => Promise<any> }) => {
        fake.hook = options?.onProviderAttempt;
        return {};
      },
    ),
    buildProviderOptions: () => undefined,
  };
});

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: vi.fn(async (input: { messages: Array<{ content: string }> }) => {
      fake.prompts.push(input.messages[0]!.content);
      const lease = await fake.hook!({
        descriptor: {
          provider: 'openai-compatible',
          modelId: 'retro-test-model',
          apiKeyEnv: 'LLM_API_KEY',
          logicalModelId: 'flash',
          scopeId: 'LLM_API_KEY:openai-compatible:default',
        },
        options: { prompt: [{ role: 'user', content: [{ type: 'text', text: 'numbers' }] }], maxOutputTokens: 800 },
      });
      lease.markProviderIoStarted();
      await lease.settle({ inputTokens: 300, outputTokens: 40 });
      return { text: '- 把 Codex 的失败写入查清楚（失败 1 次）', usage: { inputTokens: 300, outputTokens: 40 } };
    }),
  };
});

import { generateMonthlyRetro, retroDocId } from '../../../../apps/api/src/retro/generate.js';
import { collectRetroAggregates, monthKey, retroMonth } from '../../../../apps/api/src/retro/aggregate.js';
import { RETRO_CALLER } from '../../../../apps/api/src/retro/suggest.js';

let db: DatabaseProvider;
let admin: UserRow;
let member: UserRow;
let month: string;
const savedEnv = { ...process.env };

function unique(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function agentWrite(owner: UserRow, clientName: string, status: 'succeeded' | 'failed' | 'interrupted') {
  let run = await db.runtime.createRun({
    kind: 'agent_write',
    owner_user_id: owner.id,
    initiated_by_user_id: owner.id,
    source_kind: 'proxy_call',
    source_id: unique('awr'),
    max_attempts: 1,
    input: { version: 1, channel: 'mcp', client_id: 'c1', client_name: clientName, tool_id: 'knowledge_mutation' },
    actor_user_id: owner.id,
  });
  for (const next of ['claimed', 'running', status] as const) {
    run = await db.runtime.transitionRun({
      id: run.id,
      expected_version: run.version,
      to_status: next,
      idempotency_key: `test:${run.id}:${next}`,
      actor_user_id: owner.id,
      ...(next === 'running'
        ? { projection_only: true }
        : next === status
          ? {
              output: null,
              settled_at: new Date().toISOString(),
              ...(status === 'succeeded' ? {} : { error_code: `agent_write_${status}`, error_message: status }),
            }
          : {}),
    });
  }
}

async function retroDoc() {
  return db.knowledgeBase.get(retroDocId(month), 'shared');
}

beforeEach(async () => {
  process.env.USAGE_BUDGET_ORG_SCOPE_ID = unique('org');
  fake.modelAvailable = true;
  fake.prompts.length = 0;
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  admin = await createInternalTestUser(db, {
    email: `${unique('retro-admin')}@test.local`,
    nickname: 'Retro Admin',
    role: 'super',
  });
  member = await createInternalTestUser(db, { email: `${unique('retro-member')}@test.local`, nickname: 'Zed Member' });
  month = monthKey(new Date());

  await db.usageCounters.increment('page_open', 'knowledge', 'web');
  await db.usageCounters.increment('page_open', 'knowledge', 'web');
  await db.usageCounters.increment('tool_call', 'knowledge_query', 'mcp');
  await agentWrite(member, 'Codex', 'succeeded');
  await agentWrite(member, 'Codex', 'failed');
  await agentWrite(member, 'Claude Code', 'interrupted');
  await feedbackServices(db).toolFrictions.record({
    fingerprint: unique('fp'),
    tool_id: 'tables_query',
    kind: 'tool_error',
    summary: 'Table not found: "<id>"',
  });
  // Free text that names a private document and members: never to be published.
  await feedbackServices(db).toolFrictions.record({
    fingerprint: unique('fp'),
    tool_id: 'knowledge_query',
    kind: 'tool_error',
    summary: 'Could not open "SECRET-DOC-TITLE" shared by Zed Member: not found',
  });
  await feedbackServices(db).toolFrictions.record({
    fingerprint: unique('fp'),
    tool_id: null,
    kind: 'detour',
    summary: 'Alice Wang asked for the Salary Plan 2027 and the agent had to search three times',
  });
  await feedbackServices(db).featureRequests.create({
    title: 'Export dashboards as PDF',
    description: 'please',
    submitted_by: member.id,
  });
  await db.metering.recordService({
    user_id: member.id,
    service: 'web_search',
    provider: 'tavily',
    units: 1,
    unit_kind: 'call',
    cost_usd_micros: 8_000,
    client: 'mcp',
  });
  // A private document and its owner's name must never reach the retro.
  await db.knowledgeBase.create({
    doc_id: unique('private'),
    scope: 'shared',
    title: 'SECRET-PRIVATE-TITLE',
    content: 'private',
    visibility: 'private',
    status: 'published',
    created_by: member.id,
    owner_user_id: member.id,
  });
});

afterEach(async () => {
  process.env = { ...savedEnv };
  await db.close();
  _resetProvider();
});

describe('monthly retro', () => {
  it('writes the month into the team folder 复盘, aggregates only', async () => {
    const result = await generateMonthlyRetro({ db, actorId: admin.id });
    expect(result).toMatchObject({ month, doc_id: retroDocId(month), created: true, suggestions: 'included' });
    expect(result.url).toMatch(/^#\/knowledge\/doc\/doc_[0-9A-Z]+-team-retro-/);

    const doc = (await retroDoc())!;
    expect(doc.title).toBe(`${month} 复盘`);
    expect(doc.visibility).toBe('team');
    const folders = await db.drive.listFolders({ scope: 'kb', parent_id: null, visibility: 'team' });
    expect(folders.find((folder) => folder.id === doc.folder_id)?.name).toBe('复盘');

    const content = doc.content;
    for (const heading of [
      '## 一、模块使用',
      '## 二、成员的 Agent',
      '## 三、问题与需求',
      '## 四、花费',
      '## 五、下月建议',
    ]) {
      expect(content).toContain(heading);
    }
    expect(content).toMatch(/\| knowledge \| \d+ \|/);
    expect(content).toMatch(/\| Codex \| \d+ \| \d+ \| \d+ \| \d+ \|/);
    expect(content).toContain('Claude Code');
    expect(content).toContain('Export dashboards as PDF');
    expect(content).toMatch(/\| tables_query \| 工具报错 \| 找不到对象 \| \d+ \| \d+ \|/);
    expect(content).toMatch(/\| knowledge_query \| 工具报错 \| 找不到对象 \| \d+ \| \d+ \|/);
    expect(content).toContain('绕了远路');
    expect(content).toContain('web_search');
    expect(content).toContain('- 把 Codex 的失败写入查清楚');
    for (const secret of [
      'SECRET-PRIVATE-TITLE',
      'SECRET-DOC-TITLE',
      'Zed Member',
      'Alice Wang',
      'Salary Plan',
      'Table not found',
      member.email,
    ]) {
      expect(content).not.toContain(secret);
      expect(fake.prompts.join('\n')).not.toContain(secret);
    }
  });

  it('meters the suggestions to the organization as client system', async () => {
    await generateMonthlyRetro({ db, actorId: admin.id });
    const rows = (await db.executeRaw(
      sql`SELECT user_id, client, caller, service FROM usage_events WHERE kind = 'model' AND caller = ${RETRO_CALLER}`,
    )) as Array<Record<string, unknown>>;
    expect(rows).toEqual([{ user_id: null, client: 'system', caller: RETRO_CALLER, service: 'llm' }]);
  });

  it('updates the same doc on a second run — one doc, one folder, a new version', async () => {
    const first = await generateMonthlyRetro({ db, actorId: admin.id });
    const again = await generateMonthlyRetro({ db });
    expect(again.created).toBe(false);
    expect(again.doc_id).toBe(first.doc_id);
    const doc = (await retroDoc())!;
    expect((await db.knowledgeBase.listVersions(doc.id)).length).toBe(2);
    const folders = (await db.drive.listFolders({ scope: 'kb', parent_id: null, visibility: 'team' })).filter(
      (folder) => folder.name === '复盘',
    );
    expect(folders).toHaveLength(1);
  });

  it('skips the suggestions and says why when the team budget is used up', async () => {
    process.env.USAGE_BUDGET_ORG_MONTHLY_USD_MICROS = '0';
    const result = await generateMonthlyRetro({ db, actorId: admin.id });
    expect(result).toMatchObject({ suggestions: 'skipped', skipped_reason: 'over_budget' });
    const content = (await retroDoc())!.content;
    expect(content).toContain('额度已用完');
    expect(content).not.toContain('- 把 Codex');
    // The aggregates are still there.
    expect(content).toContain('Export dashboards as PDF');
  });

  it('skips the suggestions when no model is configured, without calling one', async () => {
    fake.modelAvailable = false;
    const result = await generateMonthlyRetro({ db, actorId: admin.id });
    expect(result).toMatchObject({ suggestions: 'skipped', skipped_reason: 'no_model' });
    expect(fake.prompts).toEqual([]);
    expect((await retroDoc())!.content).toContain('没有配置可用的模型');
  });

  it('tells every active super, with a link to the doc', async () => {
    const result = await generateMonthlyRetro({ db, actorId: admin.id });
    const { items } = await db.notifications.listForUser({ user_id: admin.id });
    const notice = items.find((item) => item.kind === 'system' && item.title.includes(month));
    expect(notice).toBeDefined();
    expect(notice!.payload).toMatchObject({ url: result.url, retro_month: month });
    expect((await db.notifications.listForUser({ user_id: member.id })).items).toEqual([]);
  });

  it('keeps a friction in the month it was active, even after it recurs the next month', async () => {
    const recurring = await feedbackServices(db).toolFrictions.record({
      fingerprint: unique('fp'),
      tool_id: 'files_query',
      kind: 'tool_error',
      summary: 'permission denied',
    });
    const earlier = await feedbackServices(db).toolFrictions.record({
      fingerprint: unique('fp'),
      tool_id: 'project_query',
      kind: 'tool_error',
      summary: 'timed out',
    });
    // Seen in September, then again just after September closed.
    await db.executeRaw(
      sql`UPDATE feedback SET first_seen_at = '2026-09-10T08:00:00Z', last_seen_at = '2026-10-01T00:30:00Z'
          WHERE id = ${recurring.id}`,
    );
    // Over before September began.
    await db.executeRaw(
      sql`UPDATE feedback SET first_seen_at = '2026-08-01T08:00:00Z', last_seen_at = '2026-08-20T08:00:00Z'
          WHERE id = ${earlier.id}`,
    );
    const september = await collectRetroAggregates(db, retroMonth('2026-09')!);
    const tools = september.frictions.top.map((row) => row.tool);
    expect(tools).toContain('files_query');
    expect(tools).not.toContain('project_query');
    expect(september.frictions.new).toBeGreaterThanOrEqual(1);
    const october = await collectRetroAggregates(db, retroMonth('2026-10')!);
    expect(october.frictions.top.map((row) => row.tool)).toContain('files_query');
  });

  it('groups every active friction, not the first page of them', async () => {
    const tool = unique('bulk_tool');
    await db.executeRaw(sql`
      INSERT INTO feedback (id, kind, status, fingerprint, tool_id, friction_kind, title, occurrence_count, first_seen_at, last_seen_at, created_at, updated_at)
      SELECT 'fbk_' || ${tool} || '_' || n, 'friction', 'new', ${tool} || '-' || n, ${tool}, 'tool_error', 'record not found', 2,
             '2026-08-05T08:00:00Z', '2026-08-06T08:00:00Z', now(), now()
      FROM generate_series(1, 501) AS n
    `);
    const august = await collectRetroAggregates(db, retroMonth('2026-08')!);
    expect(august.frictions.active).toBeGreaterThanOrEqual(501);
    expect(august.frictions.top.find((row) => row.tool === tool)).toEqual({
      tool,
      kind: 'tool_error',
      error_class: 'not_found',
      frictions: 501,
      occurrences: 1002,
    });
  });

  it('reads every friction exactly once even when one is recorded again between pages', async () => {
    const tool = unique('paged_tool');
    const fingerprints = Array.from({ length: 5 }, (_, index) => `${tool}-${index}`);
    for (const fingerprint of fingerprints) {
      await feedbackServices(db).toolFrictions.record({
        fingerprint,
        tool_id: tool,
        kind: 'tool_error',
        summary: 'not found',
      });
    }
    const window = {
      from: new Date(Date.now() - 86_400_000).toISOString(),
      to: new Date(Date.now() + 86_400_000).toISOString(),
    };
    const original = feedbackServices(db).toolFrictions.listActiveBetween.bind(feedbackServices(db).toolFrictions);
    let pages = 0;
    const spy = vi.spyOn(feedbackServices(db).toolFrictions, 'listActiveBetween').mockImplementation(async (input) => {
      const page = await original(input);
      // Between the first and second page the first friction happens again: under the old
      // occurrence/last-seen order with OFFSET it would jump pages and be read twice or not at all.
      if (pages++ === 0) {
        for (let i = 0; i < 3; i++) {
          await feedbackServices(db).toolFrictions.record({
            fingerprint: fingerprints[0]!,
            tool_id: tool,
            kind: 'tool_error',
            summary: 'not found',
          });
        }
      }
      return page;
    });
    try {
      const rows = (await allActiveFrictions(db, window, 2)).filter((row) => row.tool_id === tool);
      expect(rows.map((row) => row.fingerprint).sort()).toEqual([...fingerprints].sort());
      expect(pages).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('refuses a month that is malformed or has not started', async () => {
    await expect(generateMonthlyRetro({ db, month: '2026-13' })).rejects.toThrow(/YYYY-MM/);
    await expect(generateMonthlyRetro({ db, month: '2999-01' })).rejects.toThrow(/not started/);
  });
});
