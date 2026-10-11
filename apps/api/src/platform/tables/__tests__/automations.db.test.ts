/**
 * Tables automations (slice Au) against real PostgreSQL, rolled back per test:
 * the in-transaction enqueue (formula conditions, watched fields,
 * record_matched), the worker (lease, cursor, delay, retry, cancel, executor
 * downgrade, per-recipient rendering, notification dedupe), the minute sweep
 * (idempotent, no historical backfill), buttons, and migration 0024's SQL on
 * seeded legacy rows.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import {
  _resetProvider,
  initDatabase,
  type DatabaseProvider,
  type TableAutomationConfigInput,
  type TableFieldRow,
  type UserRow,
} from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { fullTableAccess } from '@greenhouse/types/table-access';
import type { TableAutomationTrigger, TableRecordWriteMeta } from '@greenhouse/types/tables';
import { createInternalTestUser } from '../../../../../../tests/helpers/internal-user.js';
import { humanActor } from '../../actor.js';
import { getPlatformRuntime, initializePlatformRuntime, resetPlatformRuntimeForTests } from '../../runtime.js';
import { tablesRegistration } from '../application.js';
import { tablesScheduling } from '../automation-schedule.js';
import { sweepTablesAutomations } from '../automation-sweep.js';
import { createTablesAutomationRunner, webhookSignature } from '../automation-worker.js';
import type { canRecipientRead } from '../access.js';

let db: DatabaseProvider;
let owner: UserRow;
let builder: UserRow;
let viewer: UserRow;
let clock: Date;

beforeEach(async () => {
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  [owner, builder, viewer] = await Promise.all([
    createInternalTestUser(db, { email: `tables-au-owner-${tag}@test.local`, nickname: 'Owner' }),
    createInternalTestUser(db, { email: `tables-au-builder-${tag}@test.local`, nickname: 'Builder' }),
    createInternalTestUser(db, { email: `tables-au-viewer-${tag}@test.local`, nickname: 'Viewer' }),
  ]);
  initializePlatformRuntime(db, [tablesRegistration]);
  clock = new Date();
});

afterEach(() => {
  resetPlatformRuntimeForTests();
  _resetProvider();
});

const full = (userId: string) => fullTableAccess(userId);
const meta = (actorId: string, extra: Partial<TableRecordWriteMeta> = {}): TableRecordWriteMeta => ({
  actorId,
  actorKind: 'user',
  enqueueAutomations: true,
  ...extra,
});

async function workspace() {
  const base = await db.tables.createBase({ name: 'Requests', owner_id: owner.id, created_by: owner.id });
  const schema = await db.tables.createTable({ base_id: base.id, name: 'Requests', created_by: owner.id });
  const tableId = schema.table.id;
  const field = (name: string, type: TableFieldRow['type'], config: Record<string, unknown> = {}) =>
    db.tables.createField({ table_id: tableId, name, type, config, created_by: owner.id });
  const status = await field('Status', 'single_select', {
    options: [
      { id: 'open', label: 'Open' },
      { id: 'done', label: 'Done' },
    ],
  });
  const amount = await field('Amount', 'number');
  const doubled = await field('Doubled', 'formula', {
    formula: {
      resultType: 'number',
      expression: {
        type: 'binary',
        operator: 'multiply',
        left: { type: 'field', fieldId: amount.id },
        right: { type: 'literal', value: 2 },
      },
    },
  });
  const assignee = await field('Assignee', 'user');
  const due = await field('Due', 'date');
  const note = await field('Note', 'text');
  await db.tables.upsertBaseMember({ base_id: base.id, user_id: builder.id, role: 'builder', added_by: owner.id });
  await db.tables.upsertBaseMember({ base_id: base.id, user_id: viewer.id, role: 'viewer', added_by: owner.id });
  return { base, tableId, primary: schema.fields[0]!, status, amount, doubled, assignee, due, note };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;

async function rule(
  t: Workspace,
  trigger: TableAutomationTrigger,
  config: TableAutomationConfigInput,
  savedBy: UserRow = owner,
) {
  return db.tables.createAutomationRule({
    base_id: t.base.id,
    table_id: t.tableId,
    name: `Rule ${Math.random().toString(36).slice(2)}`,
    status: 'enabled',
    trigger,
    config,
    user_id: savedBy.id,
    scheduling: tablesScheduling(clock),
  });
}

/** Queued rows are due at their enqueue instant (real time): move the test clock past it. */
function catchUp(): void {
  clock = new Date(Date.now() + 1_000);
}

function runner(extra: Partial<Parameters<typeof createTablesAutomationRunner>[0]> = {}) {
  return createTablesAutomationRunner({
    db,
    workerId: `au-test-${Math.random().toString(36).slice(2)}`,
    now: () => clock,
    publishOptions: { pushEnabled: false },
    ...extra,
  });
}

const create = (t: Workspace, values: Record<string, unknown>, by: UserRow = owner) =>
  db.tables.createRecord({ table_id: t.tableId, values }, full(by.id), meta(by.id));

async function update(t: Workspace, recordId: number, values: Record<string, unknown>, by: UserRow = owner) {
  const current = (await db.tables.getRecord(t.tableId, recordId, full(by.id)))!;
  const result = await db.tables.updateRecord(
    { table_id: t.tableId, record_id: recordId, revision: current.revision, values },
    full(by.id),
    meta(by.id),
  );
  if (!result.ok) throw new Error(`update failed: ${result.reason}`);
  return result.record;
}

const notifyOwner = { type: 'notify' as const, recipients: { userIds: [] as string[] }, title: 'Hi', message: 'Hello' };

describe('enqueue inside the write', () => {
  it('evaluates conditions with the SQL compiler on the write’s own computed values', async () => {
    const t = await workspace();
    const big = await rule(t, 'record_created', {
      condition: { combinator: 'and', clauses: [{ fieldId: t.doubled.id, operator: 'gt', value: 10 }] },
      actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }],
    });
    const small = await create(t, { [t.primary.id]: 'Small', [t.amount.id]: 3 });
    const large = await create(t, { [t.primary.id]: 'Large', [t.amount.id]: 6 });
    const queued = await db.tables.listAutomationOutbox(big.id);
    expect(queued.map((row) => row.record_id)).toEqual([large.id]);
    expect(queued.map((row) => row.record_id)).not.toContain(small.id);
  });

  it('fires record_updated only when a watched field changed (any field when none are watched)', async () => {
    const t = await workspace();
    const watched = await rule(t, 'record_updated', {
      watchFieldIds: [t.status.id],
      actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }],
    });
    const any = await rule(t, 'record_updated', { actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }] });
    const record = await create(t, { [t.primary.id]: 'Item', [t.status.id]: 'open' });
    await update(t, record.id, { [t.note.id]: 'just a note' });
    expect(await db.tables.listAutomationOutbox(watched.id)).toEqual([]);
    expect(await db.tables.listAutomationOutbox(any.id)).toHaveLength(1);
    await update(t, record.id, { [t.status.id]: 'done' });
    expect(await db.tables.listAutomationOutbox(watched.id)).toHaveLength(1);
    // An update that changes nothing triggers nothing.
    await update(t, record.id, { [t.status.id]: 'done' });
    expect(await db.tables.listAutomationOutbox(any.id)).toHaveLength(2);
  });

  it('fires record_matched only on the transition into the condition', async () => {
    const t = await workspace();
    const matched = await rule(t, 'record_matched', {
      condition: { combinator: 'and', clauses: [{ fieldId: t.status.id, operator: 'eq', value: 'done' }] },
      actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }],
    });
    const record = await create(t, { [t.primary.id]: 'Item', [t.status.id]: 'open' });
    expect(await db.tables.listAutomationOutbox(matched.id)).toEqual([]);
    await update(t, record.id, { [t.status.id]: 'done' });
    await update(t, record.id, { [t.note.id]: 'still done' });
    const rows = await db.tables.listAutomationOutbox(matched.id);
    expect(rows.map((row) => [row.record_id, row.trigger_kind])).toEqual([[record.id, 'record_matched']]);
    // Leaving and re-entering fires again; a record created inside the condition fires too.
    await update(t, record.id, { [t.status.id]: 'open' });
    await update(t, record.id, { [t.status.id]: 'done' });
    const born = await create(t, { [t.primary.id]: 'Born done', [t.status.id]: 'done' });
    expect((await db.tables.listAutomationOutbox(matched.id)).map((row) => row.record_id)).toEqual([
      record.id,
      record.id,
      born.id,
    ]);
  });

  it('refuses an executor in the input and a record_matched rule without a condition', async () => {
    const t = await workspace();
    await expect(
      rule(t, 'record_matched', { actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }] }),
    ).rejects.toThrow(/needs a condition/);
    const saved = await rule(
      t,
      'record_created',
      { actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }] },
      builder,
    );
    expect(saved.execution_user_id).toBe(builder.id);
    // Renaming keeps the executor; changing what the rule does makes the saver the executor.
    const renamed = await db.tables.updateAutomationRule(saved.id, {
      revision: saved.revision,
      name: 'Renamed',
      user_id: owner.id,
    });
    expect(renamed.ok && renamed.value.execution_user_id).toBe(builder.id);
    const changed = await db.tables.updateAutomationRule(saved.id, {
      revision: saved.revision + 1,
      config: { actions: [{ ...notifyOwner, recipients: { userIds: [viewer.id] } }] },
      user_id: owner.id,
    });
    expect(changed.ok && changed.value.execution_user_id).toBe(owner.id);
  });
});

describe('the worker', () => {
  it('runs actions in order, parks on a delay, resumes at the cursor and logs every step', async () => {
    const t = await workspace();
    const automation = await rule(t, 'record_created', {
      actions: [
        { type: 'update_record', values: [{ fieldId: t.note.id, value: 'seen by {{field:' + t.primary.id + '}}' }] },
        { type: 'delay', minutes: 5 },
        { type: 'notify', recipients: { creator: true }, title: 'Done', message: 'Note: {{field:' + t.note.id + '}}' },
      ],
    });
    const record = await create(t, { [t.primary.id]: 'Alpha' });
    catchUp();
    await runner().runOnce();

    const [queued] = await db.tables.listAutomationOutbox(automation.id);
    expect(queued).toMatchObject({ status: 'pending', cursor: 'a3', attempts: 0 });
    expect(Date.parse(queued!.available_at)).toBe(clock.getTime() + 5 * 60_000);
    let [run] = await db.tables.listAutomationRuns(automation.id);
    expect(run).toMatchObject({ status: 'running', actions_completed: 2 });
    expect(run!.steps.map((step) => [step.actionId, step.code])).toEqual([
      ['a1', 'record_updated'],
      ['a2', 'delayed'],
    ]);
    const written = (await db.tables.getRecord(t.tableId, record.id, full(owner.id)))!;
    expect(written.values[String(t.note.id)]).toBe('seen by Alpha');
    const events = await db.tables.listRecordEvents(record.id);
    expect(events[0]).toMatchObject({
      actor_kind: 'automation',
      meta: { ruleId: automation.id, executorId: owner.id },
    });

    // Not due yet: nothing happens.
    await runner().runOnce();
    expect((await db.tables.listAutomationOutbox(automation.id))[0]!.status).toBe('pending');
    clock = new Date(clock.getTime() + 6 * 60_000);
    await runner().runOnce();
    [run] = await db.tables.listAutomationRuns(automation.id);
    expect(run).toMatchObject({ status: 'succeeded', actions_completed: 3 });
    expect((await db.tables.listAutomationOutbox(automation.id))[0]!.status).toBe('succeeded');
    const inbox = await db.notifications.listForUser({ user_id: owner.id });
    expect(inbox.items.map((item) => item.body)).toContain('Note: seen by Alpha');
    // The automation's own write queued nothing (D6).
    expect(await db.tables.listAutomationOutbox(automation.id)).toHaveLength(1);
  });

  it('cancels a delayed run when the rule changes meanwhile', async () => {
    const t = await workspace();
    const automation = await rule(t, 'record_created', {
      actions: [
        { type: 'delay', minutes: 1 },
        { ...notifyOwner, recipients: { userIds: [owner.id] } },
      ],
    });
    await create(t, { [t.primary.id]: 'Waits' });
    catchUp();
    await runner().runOnce();
    await db.tables.updateAutomationRule(automation.id, {
      revision: automation.revision,
      config: {
        actions: [
          { type: 'delay', minutes: 1 },
          { ...notifyOwner, title: 'Changed', recipients: { userIds: [owner.id] } },
        ],
      },
      user_id: owner.id,
    });
    clock = new Date(clock.getTime() + 2 * 60_000);
    await runner().runOnce();
    const [run] = await db.tables.listAutomationRuns(automation.id);
    expect(run).toMatchObject({ status: 'canceled', error: 'rule_changed' });
    expect((await db.notifications.listForUser({ user_id: owner.id })).items).toEqual([]);
  });

  it('skips a run whose executor is no longer a builder, and never runs it as anyone else', async () => {
    const t = await workspace();
    const automation = await rule(
      t,
      'record_created',
      { actions: [{ type: 'update_record', values: [{ fieldId: t.note.id, value: 'ran' }] }] },
      builder,
    );
    await db.tables.upsertBaseMember({ base_id: t.base.id, user_id: builder.id, role: 'viewer', added_by: owner.id });
    const record = await create(t, { [t.primary.id]: 'Guarded' });
    catchUp();
    await runner().runOnce();
    const [run] = await db.tables.listAutomationRuns(automation.id);
    expect(run).toMatchObject({ status: 'canceled', error: 'executor_not_builder', actions_completed: 0 });
    expect(
      (await db.tables.getRecord(t.tableId, record.id, full(owner.id)))!.values[String(t.note.id)],
    ).toBeUndefined();
  });

  it('retries a webhook 5xx from the unfinished action only, then fails after the last attempt', async () => {
    const t = await workspace();
    const postWebhook = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 503, retryable: true, error: 'Webhook answered HTTP 503' })
      .mockResolvedValueOnce({ ok: true, status: 200, retryable: false });
    const automation = await rule(t, 'record_created', {
      actions: [
        { type: 'update_record', values: [{ fieldId: t.note.id, value: 'once' }] },
        { type: 'webhook', url: 'https://hooks.example.com/in' },
      ],
    });
    const record = await create(t, { [t.primary.id]: 'Hooked', [t.amount.id]: 4 });
    catchUp();
    await runner({ postWebhook }).runOnce();
    let [queued] = await db.tables.listAutomationOutbox(automation.id);
    expect(queued).toMatchObject({ status: 'pending', cursor: 'a2', last_error: 'Webhook answered HTTP 503' });
    clock = new Date(Date.parse(queued!.available_at) + 1);
    await runner({ postWebhook }).runOnce();
    [queued] = await db.tables.listAutomationOutbox(automation.id);
    expect(queued!.status).toBe('succeeded');
    // The finished update ran once; the webhook body carries the record fields by name.
    expect(
      (await db.tables.listRecordEvents(record.id)).filter((event) => event.actor_kind === 'automation'),
    ).toHaveLength(1);
    const body = JSON.parse(postWebhook.mock.calls[1]![1] as string);
    expect(body).toMatchObject({
      record: { id: record.id, fields: { Amount: 4, Doubled: 8, Note: 'once' } },
      trigger: 'record_created',
    });
    const [run] = await db.tables.listAutomationRuns(automation.id);
    expect(run!.steps.map((step) => step.code)).toEqual(['record_updated', 'webhook_retrying', 'webhook_sent']);

    // Always failing: three attempts, then the run fails.
    const failing = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 502, retryable: true, error: 'Webhook answered HTTP 502' });
    const second = await rule(t, 'record_created', {
      actions: [{ type: 'webhook', url: 'https://hooks.example.com/b' }],
    });
    await create(t, { [t.primary.id]: 'Fails' });
    catchUp();
    for (let pass = 0; pass < 4; pass++) {
      await runner({ postWebhook: failing }).runOnce();
      clock = new Date(clock.getTime() + 20 * 60_000);
    }
    const [failed] = await db.tables.listAutomationRuns(second.id);
    expect(failed).toMatchObject({ status: 'failed', error: 'Webhook answered HTTP 502' });
    expect((await db.tables.listAutomationOutbox(second.id))[0]).toMatchObject({ status: 'failed', attempts: 3 });
  });

  it('signs webhook bodies with the stored secret', async () => {
    const previousKey = process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
    process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
    onTestFinished(() => {
      if (previousKey === undefined) delete process.env.PROVIDER_TOKEN_ENCRYPTION_KEY;
      else process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = previousKey;
    });
    const { encryptToken } = await import('../../../auth/crypto.js');
    const t = await workspace();
    const postWebhook = vi.fn().mockResolvedValue({ ok: true, status: 204, retryable: false });
    const automation = await db.tables.createAutomationRule({
      base_id: t.base.id,
      table_id: t.tableId,
      name: 'Signed',
      status: 'enabled',
      trigger: 'record_created',
      config: { actions: [{ type: 'webhook', url: 'https://hooks.example.com/s', secret: 'k'.repeat(32) }] },
      user_id: owner.id,
      sealer: { seal: (plaintext, aad) => encryptToken(plaintext, aad) },
    });
    expect(automation.config.actions[0]).toMatchObject({ type: 'webhook', hasSecret: true });
    expect(JSON.stringify(await db.tables.listAutomationRules(t.base.id))).not.toContain('k'.repeat(32));
    await create(t, { [t.primary.id]: 'Signed' });
    catchUp();
    await runner({ postWebhook }).runOnce();
    const [, body, options] = postWebhook.mock.calls[0]!;
    expect((options as { headers: Record<string, string> }).headers['x-greenhouse-signature']).toBe(
      webhookSignature('k'.repeat(32), body as string),
    );
  });

  it('reclaims an expired lease and resumes the run where it stopped', async () => {
    const t = await workspace();
    const automation = await rule(t, 'record_created', {
      actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }],
    });
    await create(t, { [t.primary.id]: 'Crashy' });
    catchUp();
    // A worker claims and dies.
    const [claimed] = await db.tables.claimAutomationOutbox({ workerId: 'dead', leaseMs: 1_000, at: clock });
    expect(claimed).toMatchObject({ rule_id: automation.id, status: 'claimed', attempts: 1 });
    expect(await db.tables.claimAutomationOutbox({ workerId: 'other', leaseMs: 1_000, at: clock })).toEqual([]);
    clock = new Date(clock.getTime() + 5_000);
    await runner().runOnce();
    expect((await db.tables.listAutomationOutbox(automation.id))[0]).toMatchObject({ status: 'succeeded' });
    expect(await db.tables.listAutomationRuns(automation.id)).toEqual([
      expect.objectContaining({ status: 'succeeded' }),
    ]);
    expect((await db.notifications.listForUser({ user_id: owner.id })).items).toHaveLength(1);
  });

  it('never starts a batched row on a lease its turn has run down — it goes back unstarted, then runs once', async () => {
    const t = await workspace();
    const urls: string[] = [];
    // Each webhook "takes" 50 s; the batch was claimed on one 120 s lease.
    const postWebhook = vi.fn().mockImplementation(async (url: string) => {
      urls.push(url);
      clock = new Date(clock.getTime() + 50_000);
      return { ok: true, status: 200, retryable: false };
    });
    const hook = (n: number) =>
      rule(t, 'record_created', { actions: [{ type: 'webhook', url: `https://hooks.example.com/${n}` }] });
    const rules = [await hook(1), await hook(2), await hook(3)];
    await create(t, { [t.primary.id]: 'Batched' });
    catchUp();
    const worker = runner({ postWebhook });

    await worker.runOnce();
    // The third row's turn came with 20 s of the claim's lease left: handed back, its claim undone.
    expect(urls).toEqual(['https://hooks.example.com/1', 'https://hooks.example.com/2']);
    expect((await db.tables.listAutomationOutbox(rules[1]!.id))[0]).toMatchObject({ status: 'succeeded' });
    expect((await db.tables.listAutomationOutbox(rules[2]!.id))[0]).toMatchObject({
      status: 'pending',
      attempts: 0,
      lease_owner: null,
    });

    for (let pass = 0; pass < 3; pass++) {
      await worker.runOnce();
      clock = new Date(clock.getTime() + 10 * 60_000);
    }
    // Every action ran exactly once.
    expect(urls).toEqual(['https://hooks.example.com/1', 'https://hooks.example.com/2', 'https://hooks.example.com/3']);
    for (const automation of rules) {
      expect((await db.tables.listAutomationOutbox(automation.id))[0]).toMatchObject({ status: 'succeeded' });
    }
  });

  it('renders notify per recipient, writing "—" for fields the recipient may not read, and skips those who cannot read the record', async () => {
    const t = await workspace();
    const outsider = await createInternalTestUser(db, { email: `tables-au-out-${Date.now()}@test.local` });
    // A custom role hiding Amount (slice A compiles real ones; the access seam stands in for it here).
    const recipientAccess: typeof canRecipientRead = async (_ctx, userId, record) => {
      if (userId === outsider.id) return null;
      if (userId === viewer.id) {
        return {
          via: 'base',
          scope: {
            kind: 'scoped',
            userId,
            tableId: record.table_id,
            rows: [],
            editRows: [],
            readableFieldIds: [t.primary.id, t.status.id],
            editableFieldIds: [],
            canCreate: false,
            canDelete: false,
          },
        };
      }
      return { via: 'base', scope: fullTableAccess(userId) };
    };
    const automation = await rule(t, 'record_created', {
      actions: [
        {
          type: 'notify',
          recipients: { userIds: [owner.id, viewer.id, outsider.id] },
          title: '{{field:' + t.primary.id + '}} needs approval',
          message: 'Amount {{field:' + t.amount.id + '}}, status {{field:' + t.status.id + '}}',
        },
      ],
    });
    await create(t, { [t.primary.id]: 'Contract', [t.amount.id]: 9000, [t.status.id]: 'open' });
    catchUp();
    await runner({ recipientAccess }).runOnce();
    const ownerInbox = await db.notifications.listForUser({ user_id: owner.id });
    const viewerInbox = await db.notifications.listForUser({ user_id: viewer.id });
    expect(ownerInbox.items[0]).toMatchObject({ title: 'Contract needs approval', body: 'Amount 9000, status Open' });
    expect(viewerInbox.items[0]).toMatchObject({ title: 'Contract needs approval', body: 'Amount —, status Open' });
    expect((await db.notifications.listForUser({ user_id: outsider.id })).items).toEqual([]);
    const [run] = await db.tables.listAutomationRuns(automation.id);
    expect(run!.steps[0]).toMatchObject({ code: 'notified', params: { sent: 2, skipped: 1 } });
  });

  it('never notifies twice for one queued action, even when the action is replayed', async () => {
    const t = await workspace();
    const automation = await rule(t, 'record_created', {
      actions: [{ ...notifyOwner, recipients: { userIds: [owner.id, builder.id] }, channels: ['inbox', 'email'] }],
    });
    await create(t, { [t.primary.id]: 'Once' });
    catchUp();
    await runner().runOnce();
    const [row] = await db.tables.listAutomationOutbox(automation.id);
    // Replay: as if the worker died after notifying but before its checkpoint.
    await db.executeRaw(
      sql`UPDATE table_automation_outbox SET status = 'pending', cursor = 'a1', available_at = now() - interval '1 minute' WHERE id = ${row!.id}`,
    );
    await runner().runOnce();
    for (const user of [owner, builder]) {
      const items = (await db.notifications.listForUser({ user_id: user.id })).items;
      expect(items).toHaveLength(1);
      expect(items[0]!.kind).toBe('tables_automation');
    }
    const deliveries = (await db.executeRaw(
      sql`SELECT channel, recipient FROM notification_delivery_attempts d JOIN notifications n ON n.id = d.notification_id
          WHERE n.dedupe_key = ${`tables-automation:${row!.id}:a1`}`,
    )) as Array<{ channel: string; recipient: string }>;
    expect(deliveries.map((delivery) => delivery.channel).sort()).toEqual(['email', 'email']);
  });
});

describe('the minute sweep', () => {
  it('enqueues each schedule occurrence once, per record when scoped to records', async () => {
    clock = new Date('2026-10-12T08:00:30.000Z');
    const t = await workspace();
    const once = await rule(t, 'schedule', {
      schedule: { cron: '0 * * * *', timezone: 'UTC', scope: 'once' },
      actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }],
    });
    expect(once.next_fire_at && new Date(once.next_fire_at).toISOString()).toBe('2026-10-12T09:00:00.000Z');
    const perRecord = await rule(t, 'schedule', {
      schedule: { cron: '0 * * * *', timezone: 'UTC', scope: 'records' },
      condition: { combinator: 'and', clauses: [{ fieldId: t.status.id, operator: 'eq', value: 'open' }] },
      actions: [{ type: 'update_record', values: [{ fieldId: t.note.id, value: '$now' }] }],
    });
    const open = await create(t, { [t.primary.id]: 'Open', [t.status.id]: 'open' });
    await create(t, { [t.primary.id]: 'Done', [t.status.id]: 'done' });

    expect((await sweepTablesAutomations(db, { now: new Date('2026-10-12T08:59:00.000Z') })).enqueued).toBe(0);
    const at = new Date('2026-10-12T09:00:20.000Z');
    await sweepTablesAutomations(db, { now: at });
    await sweepTablesAutomations(db, { now: at });
    expect((await db.tables.listAutomationOutbox(once.id)).map((row) => row.idempotency_key)).toEqual([
      `rule:${once.id}:schedule:2026-10-12T09:00:00.000Z`,
    ]);
    expect((await db.tables.listAutomationOutbox(perRecord.id)).map((row) => row.record_id)).toEqual([open.id]);
    expect(new Date((await db.tables.getAutomationRule(once.id))!.next_fire_at!).toISOString()).toBe(
      '2026-10-12T10:00:00.000Z',
    );
  });

  it('runs only the latest missed schedule occurrence within 24 hours', async () => {
    clock = new Date('2026-10-12T08:00:30.000Z');
    const t = await workspace();
    const hourly = await rule(t, 'schedule', {
      schedule: { cron: '0 * * * *', timezone: 'UTC', scope: 'once' },
      actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }],
    });
    await sweepTablesAutomations(db, { now: new Date('2026-10-12T13:30:00.000Z') });
    expect(
      (await db.tables.listAutomationOutbox(hourly.id)).map((row) => new Date(row.scheduled_for!).toISOString()),
    ).toEqual(['2026-10-12T13:00:00.000Z']);
  });

  it('fires date rules for dates reached after the rule was saved, never for older ones, and once per date value', async () => {
    clock = new Date('2026-10-12T08:00:00.000Z');
    const t = await workspace();
    const past = await create(t, { [t.primary.id]: 'Past', [t.due.id]: '2026-10-01' });
    const soon = await create(t, { [t.primary.id]: 'Soon', [t.due.id]: '2026-10-13' });
    const dated = await rule(t, 'date_reached', {
      dateTrigger: { fieldId: t.due.id, offsetDays: 0, time: '09:00', timezone: 'Asia/Shanghai' },
      actions: [{ ...notifyOwner, recipients: { userIds: [owner.id] } }],
    });
    await sweepTablesAutomations(db, { now: new Date('2026-10-12T08:01:00.000Z') });
    expect(await db.tables.listAutomationOutbox(dated.id)).toEqual([]);
    // 2026-10-13 09:00 Asia/Shanghai = 01:00 UTC.
    await sweepTablesAutomations(db, { now: new Date('2026-10-13T00:59:00.000Z') });
    expect(await db.tables.listAutomationOutbox(dated.id)).toEqual([]);
    await sweepTablesAutomations(db, { now: new Date('2026-10-13T01:01:00.000Z') });
    await sweepTablesAutomations(db, { now: new Date('2026-10-13T01:02:00.000Z') });
    const rows = await db.tables.listAutomationOutbox(dated.id);
    expect(rows.map((row) => [row.record_id, row.idempotency_key])).toEqual([
      [soon.id, `rule:${dated.id}:date:${soon.id}:2026-10-13:0`],
    ]);
    expect(rows.map((row) => row.record_id)).not.toContain(past.id);
  });
});

describe('buttons', () => {
  it('lists buttons to people who can update the row and queues one run per request id', async () => {
    const t = await workspace();
    const button = await rule(t, 'button', {
      buttonLabel: 'Approve',
      condition: { combinator: 'and', clauses: [{ fieldId: t.status.id, operator: 'eq', value: 'open' }] },
      actions: [
        {
          type: 'update_record',
          values: [
            { fieldId: t.status.id, value: 'done' },
            { fieldId: t.assignee.id, value: '$actor' },
          ],
        },
      ],
    });
    const record = await create(t, { [t.primary.id]: 'Press me', [t.status.id]: 'open' });
    const dispatch = (actor: UserRow, actionId: 'listRecordButtons' | 'triggerAutomation', payload: unknown) =>
      getPlatformRuntime().dispatch({ actor: humanActor(actor), appId: 'tables', actionId, payload });

    expect(await dispatch(builder, 'listRecordButtons', { tableId: t.tableId, recordId: record.id })).toEqual({
      ok: true,
      data: { buttons: [{ ruleId: button.id, label: 'Approve' }] },
    });
    expect(await dispatch(viewer, 'listRecordButtons', { tableId: t.tableId, recordId: record.id })).toEqual({
      ok: true,
      data: { buttons: [] },
    });
    const viewerPress = await dispatch(viewer, 'triggerAutomation', {
      ruleId: button.id,
      recordId: record.id,
      requestId: 'press-viewer-1',
    });
    expect(viewerPress).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    const press = { ruleId: button.id, recordId: record.id, requestId: 'press-builder-1' };
    expect(await dispatch(builder, 'triggerAutomation', press)).toEqual({
      ok: true,
      data: { queued: true, duplicate: false },
    });
    expect(await dispatch(builder, 'triggerAutomation', press)).toEqual({
      ok: true,
      data: { queued: true, duplicate: true },
    });
    catchUp();
    await runner().runOnce();
    const after = (await db.tables.getRecord(t.tableId, record.id, full(owner.id)))!;
    expect(after.values).toMatchObject({ [String(t.status.id)]: 'done', [String(t.assignee.id)]: builder.id });
    // The condition no longer holds: no button, and a stale press is refused.
    expect(await dispatch(builder, 'listRecordButtons', { tableId: t.tableId, recordId: record.id })).toEqual({
      ok: true,
      data: { buttons: [] },
    });
    expect(await dispatch(builder, 'triggerAutomation', { ...press, requestId: 'press-builder-2' })).toMatchObject({
      ok: false,
      code: 'CONFLICT',
    });
  });

  it('refuses an executor in the payload and webhooks from a delegated agent', async () => {
    const t = await workspace();
    const runtime = getPlatformRuntime();
    const config = { actions: [{ type: 'webhook', url: 'https://hooks.example.com/x' }] };
    expect(
      await runtime.dispatch({
        actor: humanActor(owner),
        appId: 'tables',
        actionId: 'createAutomation',
        payload: {
          baseId: t.base.id,
          tableId: t.tableId,
          name: 'X',
          trigger: 'record_created',
          config,
          executionUserId: viewer.id,
        },
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    const agent = {
      ...humanActor(owner),
      actorType: 'agent' as const,
      actorId: `agent:${owner.id}`,
      onBehalfOfUserId: owner.id,
    };
    expect(
      await runtime.dispatch({
        actor: agent,
        appId: 'tables',
        actionId: 'createAutomation',
        payload: { baseId: t.base.id, tableId: t.tableId, name: 'Y', trigger: 'record_created', config },
      }),
    ).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect(
      await runtime.dispatch({
        actor: humanActor(owner),
        appId: 'tables',
        actionId: 'createAutomation',
        payload: {
          baseId: t.base.id,
          tableId: t.tableId,
          name: 'Z',
          trigger: 'record_created',
          config: { actions: [{ type: 'webhook', url: 'http://127.0.0.1:3000/api' }] },
        },
      }),
    ).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
  });
});

describe('migration 0024', () => {
  it('moves the legacy inbox, settles legacy outbox rows and backfills stable action ids', async () => {
    const t = await workspace();
    const [legacyRule] = (await db.executeRaw(sql`
      INSERT INTO table_automation_rules (base_id, table_id, name, status, trigger, config, execution_user_id, revision, created_by, updated_by, created_at, updated_at)
      VALUES (${t.base.id}, ${t.tableId}, 'Legacy', 'enabled', 'record_created',
        ${JSON.stringify({
          actions: [
            { type: 'notify', userIds: [owner.id], title: 'Old', message: 'Old' },
            { id: 'a1', type: 'update_record', values: {} },
            { type: 'update_record', values: {} },
          ],
        })}::jsonb,
        ${owner.id}, 1, ${owner.id}, ${owner.id}, now(), now())
      RETURNING id`)) as Array<{ id: number }>;
    const record = await db.tables.createRecord(
      { table_id: t.tableId, values: { [t.primary.id]: 'Legacy' } },
      full(owner.id),
      meta(owner.id, { enqueueAutomations: false }),
    );
    const [outbox] = (await db.executeRaw(sql`
      INSERT INTO table_automation_outbox (rule_id, record_id, event_type, payload, status, idempotency_key, created_at)
      VALUES (${legacyRule!.id}, ${record.id}, 'record_created', '{}'::jsonb, 'processing', ${`legacy-${legacyRule!.id}`}, now())
      RETURNING id`)) as Array<{ id: number }>;
    await db.executeRaw(sql`
      INSERT INTO table_automation_runs (rule_id, outbox_id, status, started_at)
      VALUES (${legacyRule!.id}, ${outbox!.id}, 'running', now())`);
    const [legacyNote] = (await db.executeRaw(sql`
      INSERT INTO table_notifications (base_id, user_id, rule_id, record_id, title, message, read_at, created_at)
      VALUES (${t.base.id}, ${viewer.id}, ${legacyRule!.id}, ${record.id}, '   ', 'Body text', '2026-10-01T00:00:00Z', '2026-09-30T00:00:00Z')
      RETURNING id`)) as Array<{ id: number }>;

    const migration = readFileSync(
      resolve(__dirname, '../../../../../../drizzle/0024_tables_automation_backfill.sql'),
      'utf8',
    );
    const statements = migration.split('--> statement-breakpoint');
    for (const statement of statements) await db.executeRaw(sql.raw(statement));
    // Re-running is harmless (notifications are keyed by the legacy id).
    for (const statement of statements) await db.executeRaw(sql.raw(statement));

    const moved = (await db.notifications.listForUser({ user_id: viewer.id })).items;
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({
      kind: 'tables_automation',
      title: 'Tables',
      body: 'Body text',
      dedupe_key: `tables-notification:${legacyNote!.id}`,
    });
    expect(moved[0]!.id).toMatch(/^ntf_[0-9a-f]{32}$/);
    expect(new Date(moved[0]!.read_at!).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(JSON.parse(moved[0]!.payload)).toEqual({ href: `#/tables/${t.base.id}` });

    expect(await db.tables.getAutomationOutbox(outbox!.id)).toMatchObject({
      status: 'failed',
      last_error: 'legacy_sync_executor',
    });
    expect((await db.tables.listAutomationRuns(legacyRule!.id))[0]).toMatchObject({
      status: 'failed',
      error: 'legacy_sync_executor',
    });
    const stored = (await db.tables.getAutomationRule(legacyRule!.id))!;
    expect(stored.config.actions.map((action) => action.id)).toEqual(['a2', 'a1', 'a3']);
    // The worker never claims a legacy row.
    expect(
      await db.tables.claimAutomationOutbox({ workerId: 'w', leaseMs: 60_000, at: new Date(Date.now() + 60_000) }),
    ).not.toContainEqual(expect.objectContaining({ id: outbox!.id }));
  });
});
