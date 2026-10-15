/** Rules enqueue facts with the record write; the tables worker executes them as run_as. */
import { createHmac, randomBytes } from 'node:crypto';
import { and, asc, eq, lte, or, sql } from 'drizzle-orm';
import {
  automationConfigSchema,
  automationInputSchema,
  type Automation,
  type AutomationInput,
} from '@greenhouse/contract';
import {
  baseAutomations,
  baseAutomationRuns,
  baseRecords,
  bases,
  jobs,
  runs,
  getDb,
  newId,
  transaction,
  type BaseAutomationRow,
  type JobRow,
} from '@greenhouse/db';
import { encrypt, decrypt } from '@greenhouse/utils/crypto';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { NotificationsService } from '../notifications/service.js';
import type { AgentsService } from '../agents/service.js';
import type { Engine } from '../../engine/engine.js';
import { enqueueJob } from '../../jobs.js';
import { ApiError, conflict, invalidInput, notFound } from '../../http/errors.js';
import { decodeCursor, toPage } from '../../http/pagination.js';
import { assertPublicEndpoint } from '../../security/network.js';
import { publicFetch } from '../../security/public-fetch.js';
import { baseAt, loadReader } from './access.js';
import { fieldsOf, tableAt } from './load.js';
import { compileFilter, inIds, recordsWhere } from './query.js';
import { scopeOf } from './scope.js';
import { tableEventChain } from './event-context.js';
import type { TablesService } from './service.js';

export const webhookSignature = (secret: string, timestamp: string, body: string) =>
  `v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
const view = (row: BaseAutomationRow): Automation => ({
  id: row.id,
  base_id: row.baseId,
  table_id: row.tableId,
  name: row.name,
  status: row.status,
  trigger: row.trigger as Automation['trigger'],
  config: automationConfigSchema.parse(row.config),
  run_as: row.runAs,
  revision: row.revision,
  next_fire_at: row.nextFireAt,
  created_at: row.createdAt,
});
type Captured = Array<{ rule: BaseAutomationRow; matched: boolean }>;
export interface AutomationHooks {
  before(tableId: string, recordId: string | null): Promise<Captured>;
  after(captured: Captured, recordId: string, revision: number, fields: string[], created: boolean): Promise<void>;
}
export function createAutomationsService(deps: {
  tables: TablesService;
  agents: AgentsService;
  engine: () => Engine;
  key: Buffer;
  notifications: NotificationsService;
  fetch?: typeof fetch;
}) {
  async function at(memberId: string, id: string) {
    const [rule] = await getDb().select().from(baseAutomations).where(eq(baseAutomations.id, id));
    if (!rule) throw notFound('Automation');
    await baseAt(await loadReader(memberId), rule.baseId, 'builder');
    return rule;
  }
  async function matches(rule: BaseAutomationRow, recordId: string) {
    const reader = await loadReader(rule.runAs);
    const source = await tableAt(reader, rule.tableId, 'viewer');
    const scope = await scopeOf(reader, source);
    const config = automationConfigSchema.parse(rule.config);
    const fields = new Map(scope.fields.map((f) => [f.id, f]));
    // Unlike a saved view, a rule whose predicate lost a field must never broaden silently.
    if (
      config.filter?.clauses.some(
        (c) => !fields.has(c.field) && !['created_at', 'updated_at', 'created_by', 'updated_by'].includes(c.field),
      )
    )
      return false;
    const [row] = await getDb()
      .select({ id: baseRecords.id })
      .from(baseRecords)
      .where(
        recordsWhere(
          rule.tableId,
          eq(baseRecords.id, recordId),
          scope.rows,
          compileFilter(config.filter, { fields, memberId: rule.runAs, timeZone: reader.timeZone }),
        ),
      );
    return !!row;
  }
  async function queue(
    rule: BaseAutomationRow,
    recordId: string | null,
    key: string,
    chain = tableEventChain.getStore() ?? [],
  ) {
    const id = newId('baseAutomationRun');
    const suppressed = chain.length >= 3 || chain.includes(`automation:${rule.id}`);
    const [row] = await getDb()
      .insert(baseAutomationRuns)
      .values({
        id,
        automationId: rule.id,
        recordId,
        trigger: rule.trigger,
        dedupeKey: key,
        revision: rule.revision,
        eventChain: [...chain, `automation:${rule.id}`],
        status: suppressed ? 'suppressed' : 'queued',
        ...(suppressed ? { error: 'chain_depth', finishedAt: sql`now()` } : {}),
      })
      .onConflictDoNothing()
      .returning();
    if (row && !suppressed)
      await enqueueJob({
        kind: 'base_automation',
        dedupeKey: `automation:${id}`,
        payload: { automation_run_id: id },
        maxAttempts: 1,
      });
    return row;
  }
  async function validate(memberId: string, baseId: string, input: AutomationInput) {
    const parsed = automationInputSchema.parse(input);
    const reader = await loadReader(memberId);
    const source = await tableAt(reader, parsed.table_id, 'builder');
    if (source.base.id !== baseId) throw invalidInput('The table must be in this base.');
    const fields = await fieldsOf(parsed.table_id);
    const ids = new Set(fields.map((f) => f.id));
    if (parsed.config.fields.some((id) => !ids.has(id)) || parsed.config.filter?.clauses.some((c) => !ids.has(c.field)))
      throw invalidInput('The rule names a field outside this table.');
    if (parsed.trigger === 'schedule' && !parsed.config.interval_minutes)
      throw invalidInput('A schedule needs an interval.');
    if (
      parsed.trigger === 'date_reached' &&
      !fields.some((f) => f.id === parsed.config.date_field_id && ['date', 'datetime'].includes(f.type))
    )
      throw invalidInput('Choose a date field.');
    for (const action of parsed.config.actions) {
      if (action.type === 'webhook') {
        try {
          const url = new URL(action.url);
          if (url.username || url.password) throw new Error();
          await assertPublicEndpoint(action.url);
        } catch {
          throw new ApiError(400, 'automation_webhook_invalid', 'The webhook needs a public HTTPS address.');
        }
      }
      if (action.type === 'agent') {
        const { agent, manifest } = await deps.agents.load(memberId, action.agent_id);
        if (
          action.output_field_id &&
          (!manifest.write || (manifest.tools && !manifest.tools.includes('table_mutation')))
        )
          throw invalidInput('This Agent cannot write its result.');
        if (agent.ownerId !== memberId) throw invalidInput('Choose your own Agent.');
        if (
          action.output_field_id &&
          !fields.some((f) => f.id === action.output_field_id && ['text', 'long_text'].includes(f.type))
        )
          throw invalidInput('The output field must be a text field in this table.');
      }
      if (action.type === 'notify')
        for (const member of action.members) {
          try {
            await tableAt(await loadReader(member), parsed.table_id, 'viewer');
          } catch {
            throw new ApiError(
              400,
              'automation_recipient_unavailable',
              'A notification recipient cannot read this table.',
            );
          }
        }
    }
    return parsed;
  }
  async function save(
    memberId: string,
    baseId: string,
    input: AutomationInput,
    previous?: BaseAutomationRow,
    revision?: number,
  ) {
    const parsed = await validate(memberId, baseId, input);
    return transaction(async () => {
      await getDb().select({ id: bases.id }).from(bases).where(eq(bases.id, baseId)).for('update');
      const rows = await getDb()
        .select({ id: baseAutomations.id })
        .from(baseAutomations)
        .where(eq(baseAutomations.baseId, baseId));
      if (!previous && rows.length >= 50) throw invalidInput('A base has at most 50 automations.');
      const id = previous?.id ?? newId('baseAutomation');
      const secret = randomBytes(32).toString('hex');
      const hasWebhook = parsed.config.actions.some((a) => a.type === 'webhook');
      const newWebhook =
        hasWebhook &&
        (!previous || !automationConfigSchema.parse(previous.config).actions.some((a) => a.type === 'webhook'));
      const values = {
        tableId: parsed.table_id,
        name: parsed.name,
        status: parsed.status,
        trigger: parsed.trigger,
        config: parsed.config,
        runAs: memberId,
        nextFireAt:
          parsed.trigger === 'schedule'
            ? new Date(Date.now() + parsed.config.interval_minutes! * 60000).toISOString()
            : null,
      };
      const [row] = previous
        ? await getDb()
            .update(baseAutomations)
            .set({
              ...values,
              ...(newWebhook ? { secretsEnc: encrypt(secret, deps.key, `automation:${id}`) } : {}),
              revision: sql`${baseAutomations.revision} + 1`,
              updatedAt: sql`now()`,
            })
            .where(and(eq(baseAutomations.id, id), eq(baseAutomations.revision, revision!)))
            .returning()
        : await getDb()
            .insert(baseAutomations)
            .values({ id, baseId, ...values, secretsEnc: encrypt(secret, deps.key, `automation:${id}`) })
            .returning();
      if (!row) throw conflict('stale_revision', 'This automation changed. Reload it.');
      return {
        ...view(row),
        ...(newWebhook ? { webhook_secret: secret } : {}),
      };
    });
  }
  const hooks: AutomationHooks = {
    async before(tableId, recordId) {
      const rules = await getDb()
        .select()
        .from(baseAutomations)
        .where(and(eq(baseAutomations.tableId, tableId), eq(baseAutomations.status, 'active')));
      const captured: Captured = [];
      for (const rule of rules)
        captured.push({
          rule,
          matched:
            rule.trigger === 'record_matched' && !!recordId ? await matches(rule, recordId).catch(() => false) : false,
        });
      return captured;
    },
    async after(captured, recordId, revision, fields, created) {
      for (const { rule, matched } of captured) {
        const config = automationConfigSchema.parse(rule.config);
        if (
          !(
            (rule.trigger === 'record_created' && created) ||
            (rule.trigger === 'record_updated' &&
              !created &&
              (!config.fields.length || config.fields.some((id) => fields.includes(id)))) ||
            (rule.trigger === 'record_matched' && !matched)
          )
        )
          continue;
        if (await matches(rule, recordId).catch(() => false))
          await queue(rule, recordId, `record:${rule.id}:${rule.revision}:${recordId}:${revision}`);
      }
    },
  };
  async function sweep() {
    await getDb()
      .update(baseAutomationRuns)
      .set({ status: 'uncertain', error: 'worker_interrupted', finishedAt: sql`now()` })
      .where(
        and(
          sql`${baseAutomationRuns.status} in ('queued','running')`,
          sql`EXISTS (SELECT 1 FROM ${jobs} WHERE ${jobs.kind} = 'base_automation' AND ${jobs.payload}->>'automation_run_id' = ${baseAutomationRuns.id} AND ${jobs.status} = 'dead')`,
        ),
      );
    const due = await getDb()
      .select()
      .from(baseAutomations)
      .where(
        and(
          eq(baseAutomations.status, 'active'),
          or(
            eq(baseAutomations.trigger, 'date_reached'),
            and(eq(baseAutomations.trigger, 'schedule'), lte(baseAutomations.nextFireAt, sql`now()`)),
          ),
        ),
      )
      .orderBy(sql`coalesce(${baseAutomations.sweptUntil}, 'epoch'::timestamptz)`, asc(baseAutomations.id))
      .limit(200);
    for (const candidate of due)
      await transaction(async () => {
        const [rule] = await getDb()
          .select()
          .from(baseAutomations)
          .where(eq(baseAutomations.id, candidate.id))
          .for('update', { skipLocked: true });
        if (!rule || rule.status !== 'active') return;
        await getDb()
          .update(baseAutomations)
          .set({ sweptUntil: sql`now()` })
          .where(eq(baseAutomations.id, rule.id));
        const config = automationConfigSchema.parse(rule.config);
        if (rule.trigger === 'schedule') {
          if (!rule.nextFireAt || Date.parse(rule.nextFireAt) > Date.now()) return;
          await queue(rule, null, `schedule:${rule.id}:${rule.revision}:${rule.nextFireAt}`);
          await getDb()
            .update(baseAutomations)
            .set({
              nextFireAt: new Date(Date.now() + config.interval_minutes! * 60000).toISOString(),
              sweptUntil: sql`now()`,
            })
            .where(eq(baseAutomations.id, rule.id));
        } else {
          const reader = await loadReader(rule.runAs).catch(() => null);
          if (!reader) return;
          const field = (await fieldsOf(rule.tableId)).find((f) => f.id === config.date_field_id);
          if (!field) return;
          // Bounded pages; the dedupe key lets every pass revisit due records safely.
          const rows = await getDb()
            .select({ id: baseRecords.id, value: sql<string>`${baseRecords.values}->>${field.id}` })
            .from(baseRecords)
            .where(
              recordsWhere(
                rule.tableId,
                sql`${baseRecords.values}->>${field.id} IS NOT NULL`,
                sql`${baseRecords.values}->>${field.id} <= ${field.type === 'date' ? new Intl.DateTimeFormat('en-CA', { timeZone: reader.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) : new Date().toISOString()}`,
                sql`NOT EXISTS (SELECT 1 FROM ${baseAutomationRuns} WHERE ${baseAutomationRuns.automationId} = ${rule.id} AND ${baseAutomationRuns.dedupeKey} = 'date:' || ${rule.id} || ':' || ${rule.revision}::text || ':' || ${baseRecords.id} || ':' || (${baseRecords.values}->>${field.id}))`,
              ),
            )
            .orderBy(baseRecords.id)
            .limit(100);
          for (const row of rows)
            if (await matches(rule, row.id).catch(() => false))
              await queue(rule, row.id, `date:${rule.id}:${rule.revision}:${row.id}:${row.value}`);
        }
      });
  }
  async function handle(job: JobRow) {
    const id = String(job.payload.automation_run_id);
    const [run] = await getDb().select().from(baseAutomationRuns).where(eq(baseAutomationRuns.id, id));
    if (!run || ['succeeded', 'failed', 'suppressed', 'uncertain'].includes(run.status))
      return { status: 'succeeded' as const };
    const [rule] = await getDb().select().from(baseAutomations).where(eq(baseAutomations.id, run.automationId));
    const finish = async (status: 'succeeded' | 'failed' | 'suppressed' | 'uncertain', error: string | null = null) => {
      await getDb()
        .update(baseAutomationRuns)
        .set({ status, error, finishedAt: sql`now()` })
        .where(and(eq(baseAutomationRuns.id, id), sql`${baseAutomationRuns.status} <> 'suppressed'`));
      return { status: 'succeeded' as const };
    };
    if (!rule || rule.status !== 'active' || rule.revision !== run.revision)
      return finish('suppressed', 'rule_changed');
    try {
      await tableAt(await loadReader(rule.runAs), rule.tableId, 'builder');
      const record = run.recordId ? await deps.tables.records.get(rule.runAs, run.recordId) : null;
      await getDb()
        .update(baseAutomationRuns)
        .set({ status: 'running', startedAt: sql`coalesce(${baseAutomationRuns.startedAt}, now())` })
        .where(eq(baseAutomationRuns.id, id));
      const config = automationConfigSchema.parse(rule.config);
      const steps = [...run.steps];
      for (const [index, action] of config.actions.entries()) {
        const prior = steps.find((s) => s.index === index);
        if (prior?.status === 'succeeded' || prior?.status === 'queued') continue;
        if (prior?.status === 'sending') return finish('uncertain', 'webhook_outcome_unknown');
        if (action.type === 'notify')
          for (const memberId of action.members) {
            const allowed = record
              ? await deps.tables.records.get(memberId, record.record.id).then(
                  () => true,
                  () => false,
                )
              : await tableAt(await loadReader(memberId), rule.tableId, 'viewer').then(
                  () => true,
                  () => false,
                );
            if (allowed)
              await deps.notifications.publish({
                memberId,
                kind: 'automation',
                title: action.title,
                targetType: record ? 'record' : 'base',
                targetId: record?.record.id ?? rule.baseId,
                dedupeKey: `automation:${id}:${index}:${memberId}`,
              });
          }
        if (action.type === 'webhook') {
          await assertPublicEndpoint(action.url);
          const body = JSON.stringify({
            id,
            automation_id: rule.id,
            trigger: rule.trigger,
            record: record?.record ?? null,
          });
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const secret = decrypt(rule.secretsEnc!, deps.key, `automation:${rule.id}`);
          steps.push({ index, status: 'sending' });
          await getDb().update(baseAutomationRuns).set({ steps }).where(eq(baseAutomationRuns.id, id));
          const response = await (deps.fetch ?? publicFetch)(action.url, {
            method: 'POST',
            redirect: 'error',
            signal: AbortSignal.timeout(10000),
            headers: {
              'content-type': 'application/json',
              'x-greenhouse-id': id,
              'x-greenhouse-timestamp': timestamp,
              'x-greenhouse-signature': webhookSignature(secret, timestamp, body),
            },
            body,
          });
          await response.body?.cancel();
          if (!response.ok) throw new Error('webhook_failed');
          steps.pop();
        }
        if (action.type === 'agent') {
          const conversation = await deps.engine().backgroundConversation(rule.runAs, action.agent_id);
          await deps.engine().deliver(conversation.id, {
            agentId: action.agent_id,
            memberId: rule.runAs,
            note: `Table automation: ${rule.name}\n${action.brief}\nRecord: ${JSON.stringify(record?.record ?? null)}`,
            dedupeKey: `table-automation:${id}:${index}`,
            eventChain: run.eventChain.slice(0, -1),
            background: {
              source: 'automation',
              sourceId: rule.id,
              automationRunId: id,
              actionIndex: index,
              title: rule.name,
              tools: action.tools === 'same_base_read' ? ['table_query'] : [],
              baseId: rule.baseId,
              ...(record && action.output_field_id
                ? {
                    result: {
                      record_id: record.record.id,
                      table_id: rule.tableId,
                      field_id: action.output_field_id,
                      revision: record.record.revision,
                    },
                  }
                : {}),
            },
          });
        }
        steps.push({ index, status: action.type === 'agent' ? 'queued' : 'succeeded' });
        await getDb().update(baseAutomationRuns).set({ steps }).where(eq(baseAutomationRuns.id, id));
      }
      return finish('succeeded');
    } catch (error) {
      return finish('failed', toErrorMessage(error).slice(0, 300));
    }
  }
  return {
    hooks,
    sweep,
    handle,
    async list(memberId: string, baseId: string, query: { cursor?: string; limit: number }) {
      await baseAt(await loadReader(memberId), baseId, 'builder');
      const rows = await getDb()
        .select()
        .from(baseAutomations)
        .where(
          and(
            eq(baseAutomations.baseId, baseId),
            query.cursor ? sql`${baseAutomations.id} > ${decodeCursor(query.cursor)}` : undefined,
          ),
        )
        .orderBy(asc(baseAutomations.id))
        .limit(query.limit + 1);
      return toPage(rows, query.limit, view);
    },
    create: (memberId: string, baseId: string, input: AutomationInput) => save(memberId, baseId, input),
    async update(memberId: string, id: string, input: AutomationInput & { revision: number }) {
      const rule = await at(memberId, id);
      return save(memberId, rule.baseId, input, rule, input.revision);
    },
    async remove(memberId: string, id: string) {
      await at(memberId, id);
      await getDb().delete(baseAutomations).where(eq(baseAutomations.id, id));
    },
    async history(memberId: string, id: string, query: { cursor?: string; limit: number }) {
      const rule = await at(memberId, id);
      const rows = await getDb()
        .select()
        .from(baseAutomationRuns)
        .where(
          and(
            eq(baseAutomationRuns.automationId, id),
            query.cursor ? sql`${baseAutomationRuns.id} > ${decodeCursor(query.cursor)}` : undefined,
          ),
        )
        .orderBy(asc(baseAutomationRuns.id))
        .limit(query.limit + 1);
      const agentRuns = await getDb()
        .select({
          id: runs.id,
          status: runs.status,
          input: runs.input,
          startedAt: runs.startedAt,
          finishedAt: runs.finishedAt,
          error: runs.errorCode,
        })
        .from(runs)
        .where(
          inIds(
            sql`${runs.input}->>'automation_run_id'`,
            rows.map((r) => r.id),
          ),
        );
      const agentIndexes = automationConfigSchema
        .parse(rule.config)
        .actions.flatMap((action, index) => (action.type === 'agent' ? [index] : []));
      return toPage(
        rows.map((r) => {
          const children = agentRuns.filter((child) => child.input.automation_run_id === r.id);
          const queued = r.steps.filter((step) => step.status === 'queued').map((step) => step.index);
          const indexes = r.revision === rule.revision ? agentIndexes : queued;
          const waitingForAgents = indexes.length > 0 && ['queued', 'running', 'succeeded'].includes(r.status);
          const status = !waitingForAgents
            ? r.status
            : children.some((child) => child.status === 'failed' || child.status === 'canceled')
              ? ('failed' as const)
              : children.length === indexes.length && children.every((child) => child.status === 'succeeded')
                ? ('succeeded' as const)
                : children.some((child) => child.status === 'waiting')
                  ? ('waiting' as const)
                  : children.some((child) => child.status !== 'queued')
                    ? ('running' as const)
                    : ('queued' as const);
          const started = children
            .map((child) => child.startedAt)
            .filter((at): at is string => !!at)
            .sort();
          const finished = children
            .map((child) => child.finishedAt)
            .filter((at): at is string => !!at)
            .sort();
          return {
            id: r.id,
            run_id: r.runId,
            automation_id: r.automationId,
            record_id: r.recordId,
            trigger: r.trigger,
            status,
            steps: r.steps.map((step) => {
              const child = children.find((child) => child.input.automation_action_index === step.index);
              return child
                ? { ...step, status: child.status === 'canceled' ? 'failed' : child.status, run_id: child.id }
                : step;
            }),
            error: children.find((child) => child.error)?.error ?? r.error,
            started_at: waitingForAgents ? (started[0] ?? null) : r.startedAt,
            finished_at: waitingForAgents
              ? ['succeeded', 'failed'].includes(status)
                ? (finished.at(-1) ?? null)
                : null
              : r.finishedAt,
            created_at: r.createdAt,
          };
        }),
        query.limit,
        (r) => r,
      );
    },
    async button(memberId: string, id: string, recordId?: string) {
      const rule = await at(memberId, id);
      if (rule.trigger !== 'button' || rule.status !== 'active')
        throw invalidInput('This rule is not an active button.');
      if (recordId && (await deps.tables.records.get(memberId, recordId)).table_id !== rule.tableId)
        throw notFound('Record');
      const row = await transaction(() => queue(rule, recordId ?? null, `button:${newId('baseAutomationRun')}`));
      deps.tables.worker.kick();
      return { id: row!.id };
    },
  };
}
export type AutomationsService = ReturnType<typeof createAutomationsService>;
