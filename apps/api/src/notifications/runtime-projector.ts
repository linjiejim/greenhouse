/** Runtime event → permanent in-app notification projection. */

import type { DatabaseProvider, RuntimeInterruptRow, RuntimeRunRow } from '@greenhouse/db';
import type { RuntimeJsonValue } from '@greenhouse/types/runtime';
import { BOT_TASK_SESSION_PREFIX } from '@greenhouse/types/session';
import { safeJsonParse } from '@greenhouse/utils/json';

import { botsLocale, copy } from '../bots/engine/copy.js';
import { botTaskMetadata } from '../bots/engine/tasks.js';
import type { RuntimeEventEnvelope } from '../runtime/worker.js';
import { publishNotification } from './publish.js';

function record(value: RuntimeJsonValue | undefined): Record<string, RuntimeJsonValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, RuntimeJsonValue>)
    : null;
}

function nestedId(payload: RuntimeJsonValue): string | null {
  const result = record(record(payload)?.result);
  return typeof result?.id === 'string' ? result.id : null;
}

function eventResult(payload: RuntimeJsonValue): Record<string, RuntimeJsonValue> | null {
  return record(record(payload)?.result);
}

function runLabel(run: RuntimeRunRow): string {
  if (run.kind === 'mission') return 'Mission';
  if (run.kind === 'workflow') return 'Workflow';
  if (run.kind === 'automation') return 'Automation';
  if (run.kind === 'subagent') return 'Subagent';
  if (run.kind === 'eval') return 'Eval';
  return 'Run';
}

/**
 * A Bots background task (a subagent run whose child session is `bottask-…`)
 * reads as the Bot and its task, not as "Subagent": the member started it from
 * a card in a conversation and the report lands back there — which is also
 * where its notification and push open (`bots_session_id`). Its words are in
 * the owner's language, like everything else Bots write.
 */
async function botTask(
  db: DatabaseProvider,
  run: RuntimeRunRow,
): Promise<{ parentSessionId: string | null; botId: string | null; title: string; locale: 'en' | 'zh' } | null> {
  if (run.kind !== 'subagent' || !run.source_id.startsWith(BOT_TASK_SESSION_PREFIX)) return null;
  const input = safeJsonParse(run.input, {}) as { title?: unknown; parent_session_id?: unknown };
  const [child, owner] = await Promise.all([db.sessions.getById(run.source_id), db.users.getById(run.owner_user_id)]);
  const meta = botTaskMetadata(child?.metadata);
  const fallback = typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '';
  return {
    parentSessionId: typeof input.parent_session_id === 'string' ? input.parent_session_id : null,
    botId: meta?.bot_id ?? null,
    title: meta?.task_title.trim() || fallback,
    locale: botsLocale(owner?.locale),
  };
}

function interruptCopy(interrupt: RuntimeInterruptRow, run: RuntimeRunRow): { title: string; body: string } {
  const label = runLabel(run);
  const title =
    interrupt.kind === 'mutation_approval' || interrupt.kind === 'workflow_gate'
      ? `${label} needs approval`
      : interrupt.kind === 'ask_user'
        ? `${label} needs your input`
        : interrupt.kind === 'credential_required'
          ? `${label} needs credentials`
          : interrupt.kind === 'budget_exceeded'
            ? `${label} reached a budget limit`
            : interrupt.kind === 'outcome_unknown'
              ? `${label} needs outcome review`
              : `${label} needs your attention`;
  return {
    title,
    body: `Open Execution Center to review ${label.toLowerCase()} ${run.source_id}.`,
  };
}

/**
 * Idempotent at-least-once observer for `startRuntimeWorker({ onEvent })`.
 * Throwing leaves the Runtime outbox row retryable; successful projection and
 * a failed transient WS push are safe because the DB notification is truth.
 */
export function createRuntimeNotificationProjector(db: DatabaseProvider) {
  return async (event: RuntimeEventEnvelope): Promise<void> => {
    if (event.type === 'interrupt.created') {
      const interruptId = nestedId(event.payload);
      if (!interruptId) throw new Error(`Runtime interrupt event ${event.event_id} has no result id`);
      const [run, interrupt] = await Promise.all([
        db.runtime.getRun(event.run_id),
        db.runtime.getInterrupt(interruptId),
      ]);
      if (!run || !interrupt) throw new Error(`Runtime interrupt event ${event.event_id} has missing source rows`);
      if (interrupt.status !== 'pending') return;
      const words = interruptCopy(interrupt, run);
      await publishNotification(db, {
        user_id: interrupt.assignee_user_id,
        kind: interrupt.kind === 'budget_exceeded' ? 'budget_attention' : 'runtime_attention',
        title: words.title,
        body: words.body,
        payload: {
          runtime_kind: run.kind,
          source_kind: run.source_kind,
          source_id: run.source_id,
          interrupt_kind: interrupt.kind,
          risk_level: interrupt.risk_level,
        },
        run_id: run.id,
        interrupt_id: interrupt.id,
        event_id: event.event_id,
        dedupe_key: `runtime-event:${event.event_id}`,
        created_at: event.created_at,
      });
      return;
    }

    if (event.type !== 'run.status_changed' && event.type !== 'run.commanded' && event.type !== 'run.domain_commanded')
      return;
    // Historical boot backfill persists this policy on the immutable terminal
    // event. Retries therefore stay quiet, while later compensation events
    // (which do not carry the policy) still create the normal unread fact.
    if (record(event.payload)?.notification_policy === 'suppress') return;
    const immutableResult = eventResult(event.payload);
    if (!immutableResult) return;
    const eventStatus = immutableResult?.status;
    if (eventStatus !== 'succeeded' && eventStatus !== 'failed' && eventStatus !== 'interrupted') return;
    const run = await db.runtime.getRun(event.run_id);
    if (!run) return;
    // Ordinary Chat is intentionally absent from Execution Center. Its turn result
    // is already visible in the conversation, so a notification per assistant
    // reply would drown out Missions, automations and real attention items.
    if (run.kind === 'chat') return;
    // Automation's domain projector owns one richer permanent fact (task name,
    // result summary and session link) and atomically fills its optional
    // transport ledger before marking the occurrence projected. Creating the
    // generic Runtime fact too would produce two inbox rows for one occurrence.
    if (run.kind === 'automation') return;
    const label = runLabel(run);
    const failed = eventStatus !== 'succeeded';
    const eventError = typeof immutableResult.error_message === 'string' ? immutableResult.error_message : null;
    const eventErrorCode = typeof immutableResult.error_code === 'string' ? immutableResult.error_code : null;
    const task = await botTask(db, run);
    const parent = task?.parentSessionId ?? null;
    await publishNotification(db, {
      user_id: run.owner_user_id,
      kind: failed ? 'runtime_failed' : 'runtime_completed',
      title: task
        ? copy.taskNotificationTitle(task.locale, task.title, !failed)
        : failed
          ? `${label} needs review`
          : `${label} completed`,
      body: task
        ? copy.taskNotificationBody(task.locale, !failed)
        : failed
          ? eventError || `Open Execution Center to review ${label.toLowerCase()} ${run.source_id}.`
          : `Open Execution Center to review the result for ${label.toLowerCase()} ${run.source_id}.`,
      payload: {
        runtime_kind: run.kind,
        source_kind: run.source_kind,
        source_id: run.source_id,
        status: eventStatus,
        error_code: eventErrorCode,
        ...(task && parent
          ? {
              bots_session_id: parent,
              bot_id: task.botId,
              task_title: task.title,
              href: `#/bots?c=${encodeURIComponent(parent)}`,
            }
          : {}),
      },
      run_id: run.id,
      event_id: event.event_id,
      dedupe_key: `runtime-terminal:${run.id}:${eventStatus}:${immutableResult.version ?? event.seq}`,
      created_at: event.created_at,
      // A Bot's background task tells the phone too (spec 20261010-mobile-push §2.1 "done").
      ...(task && parent ? { push: { k: 'done', sid: parent, open: 'bots', bot_id: task.botId, ok: !failed } } : {}),
    });
  };
}
