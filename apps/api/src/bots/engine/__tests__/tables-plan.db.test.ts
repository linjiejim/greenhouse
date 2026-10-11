/**
 * A Bot's proposed Tables change — the `tables_plan` request (spec
 * 20261011-tables-apps §7, slice AG; real PostgreSQL, rolled back per test):
 * - the Bots face of `tables_schema_plan` drafts with the chat tool's check and
 *   raises a 7-day request whose card is self-contained (lines and the
 *   permission section in the member's words) — never the chat artifact;
 * - Apply claims the request, runs the plan AS THE MEMBER through the apply
 *   path, writes the outcome back and wakes the Bot with it;
 * - a double click applies once (in-process, and across API slots through the
 *   claim's CAS), Decline applies nothing, an expired card cannot be applied,
 *   and a member who lost Tables gets the card closed instead of a half-run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetProvider, initDatabase, type BotRow, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import type { BotTablesPlanPayload, BotTablesPlanResult } from '@greenhouse/types/bots';
import type { SchemaPlanOperation } from '@greenhouse/types/tables';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { tablesRegistration } from '../../../platform/tables/application.js';
import { initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../../platform/runtime.js';
import { createBotTablesPlanTool, TABLES_PLAN_PROPOSAL_TTL_MS } from '../../tools/tables-plan.js';
import { testTurn } from '../../__tests__/helpers/turn.js';
import { expireDueRequests } from '../approvals.js';
import { decideBotRequest } from '../requests.js';

vi.mock('../../../ws/connection-manager.js', () => ({ connectionManager: { sendToUser: vi.fn() } }));
const delivered = vi.hoisted(() => [] as Array<{ sessionId: string; item: Record<string, unknown> }>);
vi.mock('../inbox.js', () => ({
  deliverToConversation: vi.fn(async (sessionId: string, item: Record<string, unknown>) => {
    delivered.push({ sessionId, item });
  }),
}));

let db: DatabaseProvider;
let user: UserRow;
let bot: BotRow;
let conversationId: string;

/** A Base with a status field and a draft app over it — what "build me a tracker" turns into. */
const PLAN: SchemaPlanOperation[] = [
  {
    op: 'base.create',
    ref: 'b',
    name: 'Errands',
    defaultTableRef: 't',
    defaultTableName: 'Errands',
    primaryFieldRef: 'title',
    primaryFieldName: 'Errand',
  },
  {
    op: 'field.create',
    ref: 'state',
    tableRef: 't',
    name: 'State',
    type: 'single_select',
    config: {
      options: [
        { id: 'open', label: 'Open' },
        { id: 'done', label: 'Done' },
      ],
    },
  },
  {
    op: 'app.create',
    ref: 'app',
    baseRef: 'b',
    name: 'Errand desk',
    spec: {
      version: 1,
      pages: [
        {
          id: 'all',
          title: 'All',
          cards: [
            {
              id: 'list',
              kind: 'records',
              layout: { x: 0, y: 0, w: 12, h: 6 },
              source: { tableId: '$table:t' },
              fieldIds: ['$field:title', '$field:state'],
            },
          ],
        },
      ],
      roles: [
        {
          key: 'member',
          name: 'Member',
          pages: 'all',
          tables: [{ tableId: '$table:t', access: 'read', fields: [], fieldDefault: 'visible' }],
        },
      ],
    },
  },
];

async function execute(tool: unknown, input: unknown): Promise<Record<string, unknown>> {
  const runnable = tool as { execute: (value: unknown, options: unknown) => Promise<Record<string, unknown>> };
  return runnable.execute(input, { toolCallId: 'tables-plan-test', messages: [] });
}

/** What the Bots face would raise for PLAN, persisted as the engine does. */
async function propose(expiresAt?: string) {
  const turn = testTurn({ userId: user.id, locale: 'zh' });
  const output = await execute(createBotTablesPlanTool(turn), { summary: '跑腿登记', operations: PLAN });
  expect(output).toMatchObject({ status: 'proposed' });
  const [kind, payload, options] = turn.createRequest.mock.calls[0]!;
  expect(kind).toBe('tables_plan');
  expect(options).toEqual({ expiresInMs: TABLES_PLAN_PROPOSAL_TTL_MS });
  return db.bots.createRequest({
    user_id: user.id,
    session_id: conversationId,
    bot_id: bot.id,
    kind: 'tables_plan',
    payload: payload as Record<string, unknown>,
    expires_at: expiresAt ?? new Date(Date.now() + TABLES_PLAN_PROPOSAL_TTL_MS).toISOString(),
  });
}

async function basesNamed(name: string) {
  return (await db.tables.listBasesForUser(user.id)).filter((base) => base.name === name);
}

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  user = await createInternalTestUser(db, {
    email: `bots-tables-plan-${Date.now()}-${Math.random()}@test.local`,
    nickname: 'Jim',
  });
  await db.users.update(user.id, { locale: 'zh' });
  bot = await db.bots.createBot({ user_id: user.id, name: 'Sage', role: 'Builder', instructions: 'Build carefully.' });
  conversationId = (await db.bots.ensureDirectConversation(user.id, bot.id)).session_id;
  initializePlatformRuntime(db, [tablesRegistration]);
  delivered.length = 0;
});

afterEach(() => {
  resetPlatformRuntimeForTests();
});

describe('the Bots face of tables_schema_plan', () => {
  it('raises a self-contained card in the member’s words — never the chat artifact', async () => {
    const turn = testTurn({ userId: user.id, locale: 'zh' });
    const output = await execute(createBotTablesPlanTool(turn), { summary: '跑腿登记', operations: PLAN });
    expect(output).toEqual(expect.objectContaining({ status: 'proposed', request_id: 'brq_1' }));
    expect(output).not.toHaveProperty('type');
    const payload = turn.createRequest.mock.calls[0]![1] as BotTablesPlanPayload;
    expect(payload).toMatchObject({ summary: '跑腿登记', operations: PLAN, access: [] });
    expect(payload.lines).toEqual([
      { op: 'base.create', label: '新建 Base', target: 'Errands' },
      { op: 'field.create', label: '新增字段', target: 'State' },
      { op: 'app.create', label: '新建应用', target: 'Errand desk' },
    ]);
  });

  it('returns every problem to the model and raises nothing', async () => {
    const turn = testTurn({ userId: user.id });
    const output = await execute(createBotTablesPlanTool(turn), {
      summary: 'Broken',
      operations: [{ op: 'field.create', tableId: 999_999, name: 'X', type: 'text' }],
    });
    expect(output.error).toMatch(/The plan was not drafted/);
    expect(turn.createRequest).not.toHaveBeenCalled();
  });
});

describe('deciding a tables_plan request', () => {
  it('applies the plan as the member, writes the outcome back and wakes the Bot with it', async () => {
    const request = await propose();
    const settled = await decideBotRequest(user.id, request.id, { decision: 'approve' }, db);
    expect(settled.status).toBe('resolved');
    const result = JSON.parse(settled.result!) as BotTablesPlanResult;
    expect(result).toMatchObject({
      decision: 'approve',
      state: 'applied',
      applied: 3,
      failed: 0,
      skipped: 0,
      lines: [{ status: 'applied' }, { status: 'applied' }, { status: 'applied' }],
    });
    const [base] = await basesNamed('Errands');
    expect(base).toMatchObject({ owner_id: user.id });
    expect(result.base_id).toBe(base!.id);
    const app = await db.tables.getApp(result.app_ids![0]!);
    expect(app).toMatchObject({ name: 'Errand desk', status: 'draft', base_id: base!.id });

    // The Bot is woken with what now exists; the transcript line says it applied.
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({
      sessionId: conversationId,
      item: {
        kind: 'continue',
        botId: bot.id,
        eventText: '已应用表格变更：跑腿登记',
        event: { kind: 'request', request_id: request.id, request_kind: 'tables_plan', bot_id: bot.id },
      },
    });
    expect(delivered[0]!.item.note).toContain(`app "app" = ${app!.id}`);
    expect(delivered[0]!.item.note).toContain(`base "b" = ${base!.id}`);
  });

  it('applies once on a double click — in this process and across slots', async () => {
    const request = await propose();
    const clicks = await Promise.allSettled([
      decideBotRequest(user.id, request.id, { decision: 'approve' }, db),
      decideBotRequest(user.id, request.id, { decision: 'approve' }, db),
    ]);
    expect(clicks.filter((click) => click.status === 'fulfilled')).toHaveLength(1);
    expect(clicks.find((click) => click.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect(await basesNamed('Errands')).toHaveLength(1);

    // Another API slot read the card while it was still pending: the claim's CAS stops it.
    const second = await propose();
    const stale = (await db.bots.getRequest(user.id, second.id))!;
    await decideBotRequest(user.id, second.id, { decision: 'approve' }, db);
    vi.spyOn(db.bots, 'getRequest').mockResolvedValueOnce(stale);
    await expect(decideBotRequest(user.id, second.id, { decision: 'approve' }, db)).rejects.toMatchObject({
      status: 409,
      code: 'already_decided',
    });
    expect(await basesNamed('Errands')).toHaveLength(2);
  });

  it('applies nothing on Decline, and says so in the thread', async () => {
    const request = await propose();
    const settled = await decideBotRequest(user.id, request.id, { decision: 'deny' }, db);
    expect(settled.status).toBe('denied');
    expect(JSON.parse(settled.result!)).toEqual({ decision: 'deny' });
    expect(await basesNamed('Errands')).toEqual([]);
    expect(delivered[0]).toMatchObject({ item: { kind: 'event', text: '你没有应用表格变更：跑腿登记' } });
  });

  it('cannot apply a card that expired', async () => {
    const request = await propose(new Date(Date.now() - 1_000).toISOString());
    const expired = await expireDueRequests(db);
    expect(expired.map((row) => row.id)).toContain(request.id);
    await expect(decideBotRequest(user.id, request.id, { decision: 'approve' }, db)).rejects.toMatchObject({
      status: 409,
      code: 'already_decided',
    });
    expect(await basesNamed('Errands')).toEqual([]);
  });

  it('closes the card instead of applying when the member no longer has Tables', async () => {
    const request = await propose();
    await db.userFeatures.upsert({ user_id: user.id, feature: 'tables', enabled: false });
    await expect(decideBotRequest(user.id, request.id, { decision: 'approve' }, db)).rejects.toMatchObject({
      status: 503,
      code: 'unavailable',
    });
    expect((await db.bots.getRequest(user.id, request.id))!.status).toBe('canceled');
    expect(await basesNamed('Errands')).toEqual([]);
  });

  it('reports a step the member may not take as failed, and the rest as applied', async () => {
    const owner = await createInternalTestUser(db, { email: `bots-tables-plan-owner-${Date.now()}@test.local` });
    const theirs = await db.tables.createBase({ name: 'Theirs', owner_id: owner.id, created_by: owner.id });
    const request = await db.bots.createRequest({
      user_id: user.id,
      session_id: conversationId,
      bot_id: bot.id,
      kind: 'tables_plan',
      payload: {
        summary: 'Mixed',
        lines: [
          { op: 'base.create', label: 'Create Base', target: 'Errands' },
          { op: 'table.create', label: 'Create table', target: 'Sneaky' },
        ],
        access: [],
        operations: [
          { op: 'base.create', ref: 'b', name: 'Errands' },
          { op: 'table.create', baseId: theirs.id, name: 'Sneaky' },
        ],
      } satisfies BotTablesPlanPayload,
    });
    const settled = await decideBotRequest(user.id, request.id, { decision: 'approve' }, db);
    const result = JSON.parse(settled.result!) as BotTablesPlanResult;
    expect(result).toMatchObject({ state: 'partial', applied: 1, failed: 1 });
    expect(result.lines![1]).toMatchObject({ status: 'failed' });
    expect(delivered[0]!.item.note).toMatch(/2 \(table\.create\)/);
  });
});
