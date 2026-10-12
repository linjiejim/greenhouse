/**
 * The Tables automation worker (docs/specs/20261011-tables-foundation.md §4, D9).
 *
 * Record writes, the minute sweep and button presses only enqueue
 * `table_automation_outbox` rows; this worker runs them, modelled on
 * `notifications/delivery-worker.ts`: SKIP LOCKED leases, a `version` CAS on
 * every write, and a boot pass. A row carries the rule revision it was queued
 * under and a snapshot of the actions; `cursor` is the next action id.
 *
 * A pass claims a batch and runs its rows one after another, all on the lease
 * of the claim. A row whose lease has run down past half by its turn is handed
 * back unstarted (`releaseAutomationOutbox`, no attempt spent) for the next
 * pass; one that starts first renews its lease to a full term, and every
 * finished action renews it again (`checkpointAutomationOutbox`), so no action
 * starts on a lease that may expire under it — and no other worker can claim
 * the row while it runs.
 *
 * Per claim:
 *  1. the rule must still be at that revision — otherwise the run is canceled
 *     `rule_changed` (an edit while a delay was pending cancels it);
 *  2. the executor must still be builder+ on the Base (and hold the automation
 *     capability) — otherwise the run is canceled `executor_not_builder` and
 *     logged; a rule never runs as anyone else (D17);
 *  3. actions run from the cursor; each success moves the cursor, so a retry or
 *     a crash resumes at the unfinished action, never repeats a finished one.
 *     `delay` parks the row until later; a webhook 5xx / 429 / timeout retries
 *     with backoff up to `max_attempts` (3); every other failure fails the run.
 *
 * The worker's own writes carry `actorKind: 'automation'` with the rule and
 * executor in the history meta, never enqueue further automations (D6), and
 * are announced over `tables:records_changed`. `notify` goes through the
 * platform notification center, rendered per recipient against what that
 * recipient may read (`canRecipientRead`).
 */

import { createHmac, randomUUID } from 'node:crypto';
import {
  normalizeStoredAutomationConfig,
  automationSecretAad,
  ruleTimeZone,
  TablesAutomationLeaseLostError,
  TablesValidationError,
  type DatabaseProvider,
  type TableAutomationOutboxRow,
  type TableFieldRow,
  type TableRecordRow,
  type UserRow,
} from '@greenhouse/db';
import { fullTableAccess } from '@greenhouse/types/table-access';
import type {
  TableAutomationAction,
  TableAutomationRecipients,
  TableAutomationRunStep,
  TableRecordWriteMeta,
} from '@greenhouse/types/tables';
import { nowIso } from '@greenhouse/utils/date';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { decryptToken } from '../../auth/crypto.js';
import { botsLocale } from '../../bots/engine/copy.js';
import { isFeishuConfigured } from '../../feishu/client.js';
import { retryAt } from '../../notifications/delivery-worker.js';
import { publishNotification, type PublishOptions } from '../../notifications/publish.js';
import { tablesPushEnvelope } from '../../notifications/push/policy.js';
import { automationDeliveryRecipient } from '../../scheduler/notify.js';
import { postPublicWebhook } from '../../security/network.js';
import { isWeComConfigured } from '../../wecom/client.js';
import { humanActor } from '../actor.js';
import { getPlatformRuntime } from '../runtime.js';
import { canRecipientRead, requireBase } from './access.js';
import {
  renderTemplate,
  resolveActionValues,
  webhookFields,
  type RenderContext,
  type RenderUser,
} from './automation-render.js';
import { publishRecordsChanged } from './realtime.js';
import { runAutomationAgent, AUTOMATION_AGENT_TIMEOUT_MS } from './automation-agent.js';

const DEFAULT_INTERVAL_MS = 2_000;
const DEFAULT_LEASE_MS = 120_000;
const DEFAULT_BATCH_SIZE = 10;
const WRITE_CONFLICT_RETRIES = 3;

export interface TablesAutomationWorkerOptions {
  db: DatabaseProvider;
  workerId?: string;
  intervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  skipBootPass?: boolean;
  now?: () => Date;
  /** Test seams. */
  runAgent?: Parameters<typeof runAutomationAgent>[0]['run'];
  postWebhook?: typeof postPublicWebhook;
  recipientAccess?: typeof canRecipientRead;
  publishOptions?: PublishOptions;
}

export interface TablesAutomationWorker {
  runOnce(): Promise<void>;
  stop(): void;
}

type ActionOutcome =
  | { kind: 'ok'; step: TableAutomationRunStep; record?: TableRecordRow }
  | { kind: 'delay'; step: TableAutomationRunStep; until: Date }
  | { kind: 'retry'; step: TableAutomationRunStep; error: string }
  | { kind: 'fail'; step: TableAutomationRunStep; error: string };

/** The HMAC a receiver checks: `sha256=<hex>` over the exact body bytes. */
export function webhookSignature(secret: string, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

function isInternalActive(user: UserRow | undefined): user is UserRow {
  return !!user && user.status === 'active' && (user.role === 'team' || user.role === 'super');
}

export function createTablesAutomationRunner(options: TablesAutomationWorkerOptions & { workerId: string }) {
  const { db, workerId } = options;
  const now = options.now ?? (() => new Date());
  const leaseMs = Math.max(options.leaseMs ?? DEFAULT_LEASE_MS, 1_000);
  const postWebhook = options.postWebhook ?? postPublicWebhook;
  const recipientAccess = options.recipientAccess ?? canRecipientRead;
  const ctx = { db };

  /** One claim of one outbox row, start to the next park / retry / settle. */
  const processRow = async (claimed: TableAutomationOutboxRow): Promise<void> => {
    let row = claimed;
    const ref = () => ({ id: row.id, expectedVersion: row.version, workerId, at: now() });
    // A full lease before anything runs; a lease already lost throws (`recover` logs it).
    row = await db.tables.renewAutomationOutbox({ ...ref(), leaseMs });
    const rule = await db.tables.getAutomationRule(row.rule_id);
    if (!rule) {
      row = await db.tables.settleAutomationOutbox({ ...ref(), status: 'failed', error: 'rule_deleted' });
      return;
    }
    const run = await db.tables.openAutomationRun(row, now());
    const steps: TableAutomationRunStep[] = [...(run.steps ?? [])];
    let completed = run.actions_completed;
    const saveRun = (patch: { status?: 'succeeded' | 'failed' | 'canceled'; error?: string | null } = {}) =>
      db.tables.updateAutomationRun(run.id, {
        steps,
        actions_completed: completed,
        ...(patch.status ? { status: patch.status, error: patch.error ?? null, finished_at: nowIso() } : {}),
      });
    const stop = async (status: 'failed' | 'canceled', error: string) => {
      await saveRun({ status, error });
      row = await db.tables.settleAutomationOutbox({ ...ref(), status: 'failed', error });
    };

    if (rule.revision !== row.rule_revision) return stop('canceled', 'rule_changed');
    const [base, table] = await Promise.all([db.tables.getBase(rule.base_id), db.tables.getTable(rule.table_id)]);
    if (!base || base.archived_at || !table || table.archived_at) return stop('canceled', 'table_unavailable');

    const executorId = rule.execution_user_id;
    const executor = humanActor({ id: executorId });
    const grant = await requireBase(ctx, executor, base.id, 'automation', 'builder');
    const capable = grant && (await getPlatformRuntime().authorize(executor, 'tables.data.automation')).allowed;
    if (!capable) {
      logger.warn('[tables-automation] skipped a run: its executor is no longer a builder on the Base', {
        ruleId: rule.id,
        baseId: base.id,
        executorId,
        outboxId: row.id,
      });
      return stop('canceled', 'executor_not_builder');
    }

    let record: TableRecordRow | null = null;
    if (row.record_id !== null) {
      record = (await db.tables.getRecord(rule.table_id, row.record_id, fullTableAccess(executorId))) ?? null;
      if (!record) return stop('canceled', 'record_unavailable');
    }

    const actions = row.actions ?? normalizeStoredAutomationConfig(rule.config).actions;
    const start = row.cursor === null ? actions.length : actions.findIndex((action) => action.id === row.cursor);
    if (start < 0) return stop('failed', `The queued run lost its place (action ${row.cursor} is gone)`);

    const users = new Map<string, UserRow | undefined>();
    const user = async (id: string) => {
      if (!users.has(id)) users.set(id, await db.users.getById(id));
      return users.get(id);
    };
    const fieldsByTable = new Map<number, TableFieldRow[]>();
    const fieldsOf = async (tableId: number) => {
      if (!fieldsByTable.has(tableId)) fieldsByTable.set(tableId, await db.tables.listFields(tableId));
      return fieldsByTable.get(tableId)!;
    };
    const payload = (row.payload ?? {}) as { actorId?: unknown };
    const actorId = typeof payload.actorId === 'string' ? payload.actorId : null;
    const timeZone = ruleTimeZone(rule.config);
    const meta: TableRecordWriteMeta = {
      actorId: executorId,
      actorKind: 'automation',
      source: { ruleId: rule.id, executorId },
      enqueueAutomations: false,
    };

    const renderUsers = async (ids: Iterable<string>): Promise<Map<string, RenderUser>> => {
      const out = new Map<string, RenderUser>();
      for (const id of ids) {
        const found = await user(id);
        if (found) out.set(id, { id, nickname: found.nickname, email: found.email });
      }
      return out;
    };
    /** Every person a record's fields mention (template rendering of person fields). */
    const personIdsOf = (source: TableRecordRow | null, fields: readonly TableFieldRow[]): string[] => {
      if (!source) return [];
      const ids = new Set<string>();
      for (const field of fields) {
        if (field.type !== 'user' && field.type !== 'multi_user') continue;
        const value = source.values[String(field.id)];
        for (const entry of Array.isArray(value) ? value : [value]) if (typeof entry === 'string') ids.add(entry);
      }
      return [...ids];
    };

    const sourceContext = async (locale: 'en' | 'zh', readable: ReadonlySet<number> | null): Promise<RenderContext> => {
      const fields = await fieldsOf(rule.table_id);
      return {
        fields: new Map(fields.map((field) => [field.id, field])),
        record,
        usersById: await renderUsers(personIdsOf(record, fields)),
        locale,
        timeZone,
        readable,
      };
    };

    const step = (action: TableAutomationAction, extra: Omit<TableAutomationRunStep, 'actionId' | 'type' | 'at'>) => ({
      actionId: action.id,
      type: action.type,
      at: now().toISOString(),
      ...extra,
    });
    const failed = (action: TableAutomationAction, error: string): ActionOutcome => ({
      kind: 'fail',
      error,
      step: step(action, { status: 'failed', code: 'failed', message: error.slice(0, 1_000) }),
    });

    const writeValues = async (action: Extract<TableAutomationAction, { type: 'update_record' | 'create_record' }>) => {
      const targetTableId = action.type === 'create_record' ? action.tableId : rule.table_id;
      const actorUser = actorId ? await user(actorId) : undefined;
      return resolveActionValues(action.values, {
        targetFields: new Map((await fieldsOf(targetTableId)).map((field) => [field.id, field])),
        source: await sourceContext('en', null),
        actor: actorUser ? { id: actorUser.id, nickname: actorUser.nickname, email: actorUser.email } : null,
        now: now(),
      });
    };

    const updateRecord = async (action: Extract<TableAutomationAction, { type: 'update_record' }>) => {
      if (!record) return failed(action, 'record_unavailable');
      const values = await writeValues(action);
      for (let attempt = 0; attempt < WRITE_CONFLICT_RETRIES; attempt++) {
        const current = await db.tables.getRecord(rule.table_id, record.id, fullTableAccess(executorId));
        if (!current) return failed(action, 'record_unavailable');
        const result = await db.tables.updateRecord(
          { table_id: rule.table_id, record_id: current.id, revision: current.revision, values },
          fullTableAccess(executorId),
          meta,
        );
        if (result.ok) {
          await publishRecordsChanged(ctx, base, rule.table_id, [result.record.id]);
          return {
            kind: 'ok',
            record: result.record,
            step: step(action, { status: 'succeeded', code: 'record_updated', params: { recordId: result.record.id } }),
          } satisfies ActionOutcome;
        }
        if (result.reason === 'not_found') return failed(action, 'record_unavailable');
      }
      return failed(action, 'The record kept changing; the update was not applied');
    };

    const createRecord = async (action: Extract<TableAutomationAction, { type: 'create_record' }>) => {
      const target = await db.tables.getTable(action.tableId);
      if (!target || target.archived_at || target.base_id !== base.id) return failed(action, 'table_unavailable');
      const created = await db.tables.createRecord(
        { table_id: target.id, values: await writeValues(action) },
        fullTableAccess(executorId),
        meta,
      );
      await publishRecordsChanged(ctx, base, target.id, [created.id]);
      return {
        kind: 'ok',
        step: step(action, { status: 'succeeded', code: 'record_created', params: { recordId: created.id } }),
      } satisfies ActionOutcome;
    };

    const recipientsOf = async (recipients: TableAutomationRecipients): Promise<string[]> => {
      const ids = new Set<string>(recipients.userIds ?? []);
      if (recipients.creator && record) ids.add(record.created_by);
      if (recipients.actor && actorId) ids.add(actorId);
      if (record) {
        const values = { ...record.values, ...record.computed_values };
        for (const fieldId of recipients.userFieldIds ?? []) {
          const value = values[String(fieldId)];
          for (const entry of Array.isArray(value) ? value : [value])
            if (typeof entry === 'string' && entry) ids.add(entry);
        }
      }
      for (const groupId of recipients.groupIds ?? []) {
        for (const member of await db.groups.listMembers(groupId)) ids.add(member.user_id);
      }
      const active: string[] = [];
      for (const id of [...ids].sort()) if (isInternalActive(await user(id))) active.push(id);
      return active;
    };

    const notify = async (action: Extract<TableAutomationAction, { type: 'notify' }>): Promise<ActionOutcome> => {
      const recipients = await recipientsOf(action.recipients);
      const channels = new Set(action.channels ?? []);
      const imChannels = channels.has('im')
        ? ([...(isWeComConfigured() ? ['wecom'] : []), ...(isFeishuConfigured() ? ['feishu'] : [])] as Array<
            'wecom' | 'feishu'
          >)
        : [];
      let sent = 0;
      let skipped = 0;
      for (const userId of recipients) {
        const recipient = (await user(userId))!;
        let readable: ReadonlySet<number> | null = null;
        let href: string | undefined;
        let viaAppId: number | null = null;
        if (record) {
          const access = await recipientAccess(ctx, userId, record);
          if (!access) {
            skipped += 1;
            continue;
          }
          if (access.via === 'app') viaAppId = access.appId;
          readable = access.scope.kind === 'full' ? null : new Set(access.scope.readableFieldIds);
          href =
            access.via === 'app'
              ? `#/apps/${access.appId}?record=${record.id}`
              : `#/tables/${base.id}/table/${rule.table_id}?record=${record.id}`;
        } else {
          // No record (a schedule that runs once): the recipient must be able to open the Base.
          const grant = await requireBase(ctx, humanActor({ id: userId }), base.id, 'record', 'viewer', {
            allowCustom: true,
          });
          if (!grant) {
            skipped += 1;
            continue;
          }
          href = `#/tables/${base.id}/table/${rule.table_id}`;
        }
        const render = await sourceContext(botsLocale(recipient.locale), readable);
        const title = renderTemplate(action.title, render).slice(0, 512);
        const message = renderTemplate(action.message, render);
        const { notification } = await publishNotification(
          db,
          {
            user_id: userId,
            kind: 'tables_automation',
            title,
            body: message,
            payload: {
              schema: 1,
              type: 'message',
              title,
              markdown: message,
              ...(href ? { href } : {}),
              baseId: base.id,
              tableId: rule.table_id,
              ruleId: rule.id,
              ...(record ? { recordId: record.id } : {}),
            },
            dedupe_key: `tables-automation:${row.id}:${action.id}`,
            // the phone (spec 20261011-mobile-tables-apps §3): urgent → "needs you", else "done"
            push: tablesPushEnvelope({
              source: 'automation',
              urgent: action.urgent === true,
              baseId: base.id,
              tableId: rule.table_id,
              recordId: record?.id ?? null,
              appId: viaAppId,
            }),
          },
          options.publishOptions,
        );
        for (const channel of imChannels) {
          await db.notifications.createDelivery({
            notification_id: notification.id,
            channel,
            recipient:
              channel === 'wecom'
                ? automationDeliveryRecipient.wecomUser(userId)
                : automationDeliveryRecipient.feishuUser(userId),
          });
        }
        if (channels.has('email')) {
          await db.notifications.createDelivery({
            notification_id: notification.id,
            channel: 'email',
            recipient: automationDeliveryRecipient.emailUser(userId),
          });
        }
        sent += 1;
      }
      return {
        kind: 'ok',
        step: step(action, {
          status: sent === 0 ? 'skipped' : 'succeeded',
          code: 'notified',
          params: { sent, skipped },
        }),
      };
    };

    const webhook = async (action: Extract<TableAutomationAction, { type: 'webhook' }>): Promise<ActionOutcome> => {
      const fields = await fieldsOf(rule.table_id);
      const body = JSON.stringify({
        rule: { id: rule.id, name: rule.name },
        base: { id: base.id, name: base.name },
        table: { id: table.id, name: table.name },
        record: record ? { id: record.id, fields: webhookFields(fields, record, action.fieldIds) } : null,
        trigger: row.trigger_kind,
        occurredAt: new Date(row.scheduled_for ?? row.created_at).toISOString(),
        deliveryId: `${row.id}:${action.id}`,
      });
      const headers: Record<string, string> = {
        'user-agent': 'Greenhouse-Automations',
        'x-greenhouse-delivery': `${row.id}:${action.id}`,
      };
      const sealed = await db.tables.getAutomationSecret(rule.id, action.id);
      if (sealed) {
        let secret: string;
        try {
          secret = decryptToken(sealed, automationSecretAad(rule.id, action.id));
        } catch {
          return failed(action, 'The webhook secret could not be opened; set it again');
        }
        headers['x-greenhouse-signature'] = webhookSignature(secret, body);
      }
      const result = await postWebhook(action.url, body, { headers });
      if (result.ok) {
        return {
          kind: 'ok',
          step: step(action, { status: 'succeeded', code: 'webhook_sent', params: { status: result.status ?? 0 } }),
        };
      }
      const error = result.error ?? 'Webhook failed';
      if (result.retryable && row.attempts < row.max_attempts) {
        return {
          kind: 'retry',
          error,
          step: step(action, {
            status: 'failed',
            code: 'webhook_retrying',
            params: { attempt: row.attempts, of: row.max_attempts },
            message: error,
          }),
        };
      }
      return failed(action, error);
    };

    const runAction = async (action: TableAutomationAction): Promise<ActionOutcome> => {
      try {
        switch (action.type) {
          case 'update_record':
            return await updateRecord(action);
          case 'create_record':
            return await createRecord(action);
          case 'notify':
            return await notify(action);
          case 'webhook':
            return await webhook(action);
          case 'delay': {
            const until = new Date(now().getTime() + action.minutes * 60_000);
            return {
              kind: 'delay',
              until,
              step: step(action, { status: 'succeeded', code: 'delayed', params: { until: until.toISOString() } }),
            };
          }
          case 'agent': {
            // Commit the non-replay boundary before creating the session or touching the provider.
            row = await db.tables.startAutomationAgent({ ...ref(), leaseMs: AUTOMATION_AGENT_TIMEOUT_MS + 60_000 });
            try {
              const generated = await runAutomationAgent({
                db,
                rule,
                action,
                outboxId: row.id,
                record,
                run: options.runAgent,
              });
              return {
                kind: 'ok',
                ...(generated.record ? { record: generated.record } : {}),
                step: step(action, {
                  status: 'succeeded',
                  message: `AI-generated · ${generated.sessionId}`,
                  params: {
                    sessionId: generated.sessionId,
                    inputTokens: generated.result.usage?.inputTokens ?? 0,
                    outputTokens: generated.result.usage?.outputTokens ?? 0,
                    steps: generated.result.pipeline.length,
                  },
                }),
              };
            } catch (error) {
              return failed(action, toErrorMessage(error));
            }
          }
        }
      } catch (error) {
        if (error instanceof TablesValidationError) return failed(action, error.message);
        throw error;
      }
    };

    for (let index = start; index < actions.length; index++) {
      const action = actions[index]!;
      const outcome = await runAction(action);
      steps.push(outcome.step);
      if (outcome.kind === 'fail') return stop('failed', outcome.error);
      if (outcome.kind === 'retry') {
        await saveRun();
        row = await db.tables.retryAutomationOutbox({
          ...ref(),
          error: outcome.error,
          retryAt: new Date(retryAt(row.attempts, now())),
        });
        return;
      }
      completed += 1;
      if (outcome.kind === 'ok' && outcome.record) record = outcome.record;
      const next = actions[index + 1];
      if (outcome.kind === 'delay' && next) {
        await saveRun();
        row = await db.tables.parkAutomationOutbox({ ...ref(), cursor: next.id, availableAt: outcome.until });
        return;
      }
      row = await db.tables.checkpointAutomationOutbox({ ...ref(), cursor: next?.id ?? null, leaseMs });
      await saveRun();
    }
    await saveRun({ status: 'succeeded' });
    row = await db.tables.settleAutomationOutbox({ ...ref(), status: 'succeeded' });
  };

  /** A row whose processing threw: retry it later while attempts remain, else dead-letter it. */
  const recover = async (claimed: TableAutomationOutboxRow, error: unknown): Promise<void> => {
    if (error instanceof TablesAutomationLeaseLostError) {
      logger.warn('[tables-automation] lost a lease mid-run; the next claimer resumes it', { outboxId: claimed.id });
      return;
    }
    const message = toErrorMessage(error);
    try {
      const latest = (await db.tables.getAutomationOutbox(claimed.id)) ?? claimed;
      const ref = { id: latest.id, expectedVersion: latest.version, workerId, at: now() };
      if (latest.attempts < latest.max_attempts) {
        await db.tables.retryAutomationOutbox({
          ...ref,
          error: message,
          retryAt: new Date(retryAt(latest.attempts, now())),
        });
        logger.warn('[tables-automation] run threw; it will resume at its cursor', {
          outboxId: claimed.id,
          error: message,
        });
        return;
      }
      await db.tables.settleAutomationOutbox({ ...ref, status: 'dead_letter', error: message });
      const run = await db.tables.openAutomationRun(latest, now());
      await db.tables.updateAutomationRun(run.id, { status: 'failed', error: message, finished_at: nowIso() });
      logger.error('[tables-automation] run reached dead letter', { outboxId: claimed.id, error: message });
    } catch (settleError) {
      logger.warn('[tables-automation] could not settle a run after an error', {
        outboxId: claimed.id,
        error: toErrorMessage(settleError),
      });
    }
  };

  const leaseLeft = (row: TableAutomationOutboxRow): number =>
    row.lease_expires_at ? Date.parse(row.lease_expires_at) - now().getTime() : 0;

  /** Unstarted rows of this pass go back to pending; one whose lease already lapsed is reclaimed as usual. */
  const release = async (rows: readonly TableAutomationOutboxRow[]): Promise<void> => {
    for (const row of rows) {
      try {
        await db.tables.releaseAutomationOutbox({
          id: row.id,
          expectedVersion: row.version,
          workerId,
          at: now(),
          attempts: row.attempts,
        });
      } catch (error) {
        if (!(error instanceof TablesAutomationLeaseLostError)) throw error;
      }
    }
  };

  let running = false;
  return {
    /** One pass: claim a batch and run each row to its next stop. */
    async runOnce(): Promise<number> {
      if (running) return 0;
      running = true;
      try {
        const rows = await db.tables.claimAutomationOutbox({
          workerId,
          leaseMs,
          limit: Math.min(Math.max(options.batchSize ?? DEFAULT_BATCH_SIZE, 1), 100),
          at: now(),
        });
        // Sequential: rule order within a batch stays the enqueue order. The rows
        // behind a slow one wait on the claim's lease; once it is half spent they
        // go back unstarted rather than start on a lease that may lapse mid-action.
        for (const [index, row] of rows.entries()) {
          if (leaseLeft(row) < leaseMs / 2) {
            await release(rows.slice(index));
            break;
          }
          try {
            await processRow(row);
          } catch (error) {
            await recover(row, error);
          }
        }
        return rows.length;
      } finally {
        running = false;
      }
    },
  };
}

/** Start the worker: a boot pass, then a pass every `intervalMs`. */
export async function startTablesAutomationWorker(
  options: TablesAutomationWorkerOptions,
): Promise<TablesAutomationWorker> {
  const workerId = options.workerId ?? `tables-automation-${process.pid}-${randomUUID().slice(0, 8)}`;
  const runner = createTablesAutomationRunner({ ...options, workerId });
  let stopped = false;
  const runOnce = async () => {
    if (stopped) return;
    await runner.runOnce();
  };
  if (!options.skipBootPass) await runOnce();
  const timer = setInterval(
    () =>
      void runOnce().catch((error) =>
        logger.error('[tables-automation] worker pass failed', { error: toErrorMessage(error) }),
      ),
    Math.max(options.intervalMs ?? DEFAULT_INTERVAL_MS, 250),
  );
  timer.unref();
  return {
    runOnce,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
