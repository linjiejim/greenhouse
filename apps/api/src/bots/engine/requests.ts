/**
 * Deciding a "needs you" request — POST /api/bots/requests/:id (spec §4–§7).
 *
 * The member's click is the only thing that turns a Bot's proposal into an
 * effect, always under the member's own credentials:
 * - approval   → wakes the waiting tool call (allow / always / deny);
 * - bot_create → creates the Bot with the member's edits, adds it to the
 *                DM as a guest, writes the "created"/"joined" lines and its
 *                greeting, then wakes the proposing Bot to hand the work over;
 * - task_start → admits the background task (≤3 running per member);
 * - instructions_update → a new version of the Bot;
 * - tables_plan → applies the proposed Tables plan AS THE MEMBER, through the
 *   same path a confirmed chat plan takes (claim, apply, write the outcome
 *   back, hand it to the Bot);
 * - login / takeover → the computer layer (secure fill / hand-back).
 * Settling is exactly once (`db.bots.settleRequest` is a CAS on `pending`);
 * a second click gets 409 `already_decided` (`deciding` while the first is
 * still in flight), which a card reads as "settled elsewhere" — every other
 * 409 carries its own code (page_gone, limit, bot_gone, …) and keeps the card
 * open. A card in a retired group chat is never carried out: 409 `group_closed`
 * (a still-pending one is withdrawn as `canceled`). Transcript lines go through
 * the single writer.
 */

import { BotsDomainError, getDb, type BotRequestRow, type DatabaseProvider } from '@greenhouse/db';
import { avatarConfigSchema } from '@greenhouse/types/profile-manifest';
import type {
  BotCreatePayload,
  BotInstructionsUpdatePayload,
  BotRequestDecision,
  BotTablesPlanPayload,
  BotTablesPlanResult,
  BotTaskStartPayload,
} from '@greenhouse/types/bots';
import type { SchemaPlanApplyResult } from '@greenhouse/types/tables';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import { connectionManager } from '../../ws/connection-manager.js';
import { userHasFeature } from '../../auth/features.js';
import { dispatchTablesMemberAction } from '../../platform/tables/agent-adapter.js';
import {
  analyzeSchemaPlan,
  applySchemaPlan,
  planTouchesApps,
  schemaPlanApplySchema,
} from '../../platform/tables/schema-plan.js';
import { handleLoginDecision, handleTakeoverDecision, SecureLoginError } from '../computer/index.js';
import { pushAttention, requestSubject, resolveApprovalWaiter } from './approvals.js';
import { botsLocale, copy } from './copy.js';
import { writeGreeting } from './greeting.js';
import { deliverToConversation } from './inbox.js';
import { validateBotInstructions, validateBotName, validateBotRole } from './naming.js';
import { admitBotTask, BotTaskError, cancelBotTask } from './tasks.js';

export class RequestDecisionError extends Error {
  constructor(
    readonly status: 400 | 404 | 409 | 503,
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'RequestDecisionError';
  }
}

const inFlight = new Set<string>();

function parseDecision(raw: unknown): BotRequestDecision {
  const body = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'always' && decision !== 'deny') {
    throw new RequestDecisionError(400, 'decision must be approve, always or deny');
  }
  return body as unknown as BotRequestDecision;
}

async function settle(
  db: DatabaseProvider,
  row: BotRequestRow,
  status: 'resolved' | 'denied',
  result?: Record<string, unknown>,
): Promise<BotRequestRow> {
  const settled = await db.bots.settleRequest(row.user_id, row.id, status, result);
  if (!settled) throw new RequestDecisionError(409, 'This request was already decided', 'already_decided');
  return settled;
}

/** A Bot's proposal to change its own instructions: accepted = a new version of the Bot. */
async function decideInstructionsUpdate(db: DatabaseProvider, row: BotRequestRow, decision: BotRequestDecision) {
  const user = await db.users.getById(row.user_id);
  const locale = botsLocale(user?.locale);
  const proposal = safeJsonParse(row.payload, {}) as BotInstructionsUpdatePayload;
  const bot = row.bot_id ? await db.bots.getBot(row.user_id, row.bot_id) : undefined;
  const botName = bot?.name ?? 'Bot';
  if (decision.decision === 'deny') {
    const settled = await settle(db, row, 'denied', { decision: 'deny' });
    await deliverToConversation(row.session_id, {
      kind: 'event',
      text: copy.declined(locale, 'instructions_update', proposal.reason ?? ''),
      event: { kind: 'request', request_id: row.id, request_kind: 'instructions_update', bot_id: row.bot_id },
    });
    return settled;
  }
  if (!bot || bot.status !== 'active') throw new RequestDecisionError(409, 'The Bot no longer exists', 'bot_gone');
  const instructions = validateBotInstructions(decision.instructions ?? proposal.instructions);
  if (!instructions.ok) throw new RequestDecisionError(400, instructions.error, instructions.code);
  const updated = await db.bots.updateBot(row.user_id, bot.id, {
    instructions: instructions.instructions,
    change_log: `Proposed by ${botName}: ${(proposal.reason ?? '').slice(0, 200)}`,
    created_by: row.user_id,
  });
  if (!updated) throw new RequestDecisionError(409, 'The Bot no longer exists', 'bot_gone');
  const settled = await settle(db, row, 'resolved', { decision: decision.decision, version: updated.current_version });
  await deliverToConversation(row.session_id, {
    kind: 'event',
    text: copy.instructionsUpdated(locale, updated.name, updated.current_version),
    event: { kind: 'instructions_updated', bot_id: updated.id, version: updated.current_version },
  });
  return settled;
}

async function decideBotCreate(db: DatabaseProvider, row: BotRequestRow, decision: BotRequestDecision) {
  const user = await db.users.getById(row.user_id);
  const locale = botsLocale(user?.locale);
  const proposal = safeJsonParse(row.payload, {}) as BotCreatePayload;
  if (decision.decision === 'deny') {
    const settled = await settle(db, row, 'denied', { decision: 'deny' });
    await deliverToConversation(row.session_id, {
      kind: 'event',
      text: copy.declined(locale, 'bot_create', proposal.name ?? ''),
      event: { kind: 'request', request_id: row.id, request_kind: 'bot_create', bot_id: row.bot_id },
    });
    return settled;
  }

  const edits = decision.bot ?? {};
  const name = validateBotName(edits.name ?? proposal.name, user?.nickname ?? '');
  if (!name.ok) throw new RequestDecisionError(400, name.error, name.code);
  const role = validateBotRole(edits.role ?? proposal.role);
  if (!role.ok) throw new RequestDecisionError(400, role.error, role.code);
  const instructions = validateBotInstructions(edits.instructions ?? proposal.instructions);
  if (!instructions.ok) throw new RequestDecisionError(400, instructions.error, instructions.code);
  const avatar = avatarConfigSchema.safeParse(edits.avatar ?? proposal.avatar ?? {});
  if (!avatar.success) throw new RequestDecisionError(400, 'Invalid avatar', 'bot_name_invalid');

  // Create first (a taken name is a 400 the member can fix on the card), then
  // settle; a lost settle race archives the duplicate instead of leaving it.
  let bot;
  try {
    bot = await db.bots.createBot({
      user_id: row.user_id,
      name: name.name,
      role: role.role,
      instructions: instructions.instructions,
      avatar: JSON.stringify(avatar.data),
      template_key: proposal.template_key ?? null,
    });
  } catch (error) {
    if (error instanceof BotsDomainError) throw new RequestDecisionError(400, error.message, error.code);
    throw error;
  }
  let settled: BotRequestRow;
  try {
    settled = await settle(db, row, 'resolved', { decision: decision.decision, bot_id: bot.id });
  } catch (error) {
    await db.bots.archiveBot(row.user_id, bot.id).catch(() => undefined);
    throw error;
  }

  const dm = await db.bots.ensureDirectConversation(row.user_id, bot.id);
  await writeGreeting(db, dm.session_id, bot);
  let joined = false;
  try {
    await db.bots.addMember(row.user_id, row.session_id, bot.id, row.bot_id ? `bot:${row.bot_id}` : 'user');
    joined = true;
  } catch (error) {
    // Full conversation, or it was removed meanwhile: the Bot still exists with its DM.
    logger.info('[bots] confirmed Bot could not join the conversation', { error: toErrorMessage(error) });
  }
  const proposer = row.bot_id ? await db.bots.getBot(row.user_id, row.bot_id) : undefined;
  await deliverToConversation(row.session_id, {
    kind: 'event',
    text: copy.created(locale, bot.name),
    event: { kind: 'created', bot_id: bot.id },
  });
  if (joined) {
    const joinedLine = copy.joined(locale, bot.name, proposer?.name);
    const joinedEvent = {
      kind: 'joined' as const,
      bot_id: bot.id,
      by: proposer ? ('bot' as const) : ('user' as const),
      ...(proposer ? { by_bot_id: proposer.id } : {}),
    };
    if (proposer && proposer.status === 'active') {
      await deliverToConversation(row.session_id, {
        kind: 'continue',
        botId: proposer.id,
        note: copy.continueAfterCreate(locale, bot.name),
        eventText: joinedLine,
        event: joinedEvent,
      });
    } else {
      await deliverToConversation(row.session_id, { kind: 'event', text: joinedLine, event: joinedEvent });
    }
  }
  return settled;
}

async function decideTaskStart(db: DatabaseProvider, row: BotRequestRow, decision: BotRequestDecision) {
  const user = await db.users.getById(row.user_id);
  const locale = botsLocale(user?.locale);
  const payload = safeJsonParse(row.payload, {}) as BotTaskStartPayload;
  if (decision.decision === 'deny') {
    const settled = await settle(db, row, 'denied', { decision: 'deny' });
    await deliverToConversation(row.session_id, {
      kind: 'event',
      text: copy.declined(locale, 'task_start', payload.title ?? ''),
      event: { kind: 'request', request_id: row.id, request_kind: 'task_start', bot_id: row.bot_id },
    });
    return settled;
  }
  const bot = row.bot_id ? await db.bots.getBot(row.user_id, row.bot_id) : undefined;
  if (!bot || bot.status !== 'active')
    throw new RequestDecisionError(409, 'The Bot that proposed this task no longer exists', 'bot_gone');
  let admitted;
  try {
    admitted = await admitBotTask({
      db,
      userId: row.user_id,
      conversationId: row.session_id,
      bot,
      title: payload.title ?? '',
      brief: payload.brief ?? '',
      requestId: row.id,
    });
  } catch (error) {
    if (error instanceof BotTaskError) {
      if (error.code === 'unavailable') {
        // The deployment turned background tasks off after the card was raised:
        // close the card (it could never succeed) and say why in the thread.
        if (await db.bots.settleRequest(row.user_id, row.id, 'canceled', { decision: 'unavailable' })) {
          await deliverToConversation(row.session_id, {
            kind: 'event',
            text: copy.taskUnavailable(locale, payload.title ?? ''),
            event: { kind: 'request', request_id: row.id, request_kind: 'task_start', bot_id: row.bot_id },
          });
        }
      }
      throw new RequestDecisionError(
        error.code === 'unavailable' ? 503 : error.code === 'limit' ? 409 : 400,
        error.message,
        error.code,
      );
    }
    throw error;
  }
  // Admitted first (a full task list is a 409 the member can act on), then
  // settled. A lost settle (the Bot was archived and its cards withdrawn, or
  // the write failed) must not leave a task running behind a card that says
  // otherwise — unless the winner is this very run (another click/slot settled
  // the same request: admission is idempotent per request id).
  let settled: BotRequestRow;
  try {
    settled = await settle(db, row, 'resolved', { decision: decision.decision, run_id: admitted.runId });
  } catch (error) {
    const latest = await db.bots.getRequest(row.user_id, row.id).catch(() => undefined);
    const sameRun =
      latest?.status === 'resolved' &&
      (safeJsonParse(latest.result ?? '{}', {}) as { run_id?: unknown }).run_id === admitted.runId;
    if (!sameRun) await cancelBotTask(db, row.user_id, admitted.runId).catch(() => undefined);
    throw error;
  }
  await deliverToConversation(row.session_id, {
    kind: 'event',
    text: copy.taskStarted(locale, bot.name, payload.title ?? ''),
    event: { kind: 'task_started', run_id: admitted.runId, bot_id: bot.id, title: payload.title ?? '' },
    botId: bot.id,
  });
  return settled;
}

/** What an apply did, for the card (per line) and the Bot (counts, failures, what now exists). */
function tablesPlanOutcome(applied: SchemaPlanApplyResult): BotTablesPlanResult {
  const count = (status: 'applied' | 'failed' | 'skipped') =>
    applied.results.filter((entry) => entry.status === status).length;
  const [done, failed, skipped] = [count('applied'), count('failed'), count('skipped')];
  return {
    decision: 'approve',
    state: failed + skipped === 0 ? 'applied' : done === 0 ? 'failed' : 'partial',
    lines: applied.results.map((entry) => ({
      status: entry.status,
      ...(entry.message ? { message: entry.message } : {}),
    })),
    applied: done,
    failed,
    skipped,
    ...(applied.baseId === undefined ? {} : { base_id: applied.baseId }),
    app_ids: applied.results.flatMap((entry) =>
      entry.op === 'app.create' && entry.status === 'applied' && entry.id !== undefined ? [entry.id] : [],
    ),
  };
}

/**
 * A Bot's proposed Tables change (`tables_schema_plan` in a Bots turn). Approve
 * runs it AS THE MEMBER, exactly as the chat card's apply route does: every
 * operation is its own runtime action, so a plan can never do more than the
 * member could by hand (the owner's steps fail for a builder, a lost grant
 * fails its step). Claim first — settling `resolved` with state `applying` is
 * the CAS that makes a double click apply once — then apply, then write the
 * outcome back into the request and wake the Bot with it.
 */
async function decideTablesPlan(db: DatabaseProvider, row: BotRequestRow, decision: BotRequestDecision) {
  const user = await db.users.getById(row.user_id);
  const locale = botsLocale(user?.locale);
  const payload = safeJsonParse(row.payload, {}) as Partial<BotTablesPlanPayload>;
  const summary = payload.summary ?? '';
  const event = {
    kind: 'request' as const,
    request_id: row.id,
    request_kind: 'tables_plan' as const,
    bot_id: row.bot_id,
  };
  if (decision.decision === 'deny') {
    const settled = await settle(db, row, 'denied', { decision: 'deny' } satisfies BotTablesPlanResult);
    await deliverToConversation(row.session_id, {
      kind: 'event',
      text: copy.declined(locale, 'tables_plan', summary),
      event,
    });
    return settled;
  }

  // The stored plan is data: shape and order are re-checked; every step is re-authorized on apply.
  const parsed = schemaPlanApplySchema.safeParse({ operations: payload.operations });
  if (!parsed.success || 'error' in analyzeSchemaPlan(parsed.data.operations)) {
    throw new RequestDecisionError(400, 'This plan can no longer be applied — ask the Bot for a new one');
  }
  const operations = parsed.data.operations;
  const allowed =
    !!user &&
    (await userHasFeature(user.id, user.role, 'tables')) &&
    (!planTouchesApps(operations) || (await userHasFeature(user.id, user.role, 'apps')));
  if (!allowed) {
    // Like a background task the deployment turned off: the card could never succeed — close it, say why.
    if (await db.bots.settleRequest(row.user_id, row.id, 'canceled', { decision: 'unavailable' })) {
      await deliverToConversation(row.session_id, {
        kind: 'event',
        text: copy.tablesPlanUnavailable(locale, summary),
        event,
      });
    }
    throw new RequestDecisionError(503, 'Tables or Apps are turned off for you', 'unavailable');
  }

  const claimed = await settle(db, row, 'resolved', {
    decision: 'approve',
    state: 'applying',
  } satisfies BotTablesPlanResult);
  let outcome: BotTablesPlanResult;
  let created = '';
  try {
    const applied = await applySchemaPlan(operations, (actionId, input, ids) =>
      dispatchTablesMemberAction(row.user_id, actionId, input, ids),
    );
    outcome = tablesPlanOutcome(applied);
    created = Object.entries(applied.refs ?? {})
      .map(([ref, entry]) => `${entry.kind} "${ref}" = ${entry.id}`)
      .join(', ');
  } catch (error) {
    logger.warn('[bots] tables plan apply crashed', { requestId: row.id, error: toErrorMessage(error) });
    outcome = { decision: 'approve', state: 'failed', error: toErrorMessage(error) };
  }
  const settled = (await db.bots.updateRequestResult(row.user_id, row.id, { ...outcome })) ?? claimed;

  const counts = { applied: outcome.applied ?? 0, failed: outcome.failed ?? 0, skipped: outcome.skipped ?? 0 };
  const eventText =
    outcome.error !== undefined
      ? copy.tablesPlanFailed(locale, summary)
      : copy.tablesPlanApplied(locale, summary, counts);
  const problems = (outcome.lines ?? []).flatMap((line, index) =>
    line.status === 'applied'
      ? []
      : [`${index + 1} (${payload.lines?.[index]?.op ?? '?'}): ${line.message ?? line.status}`],
  );
  const bot = row.bot_id ? await db.bots.getBot(row.user_id, row.bot_id) : undefined;
  if (bot && bot.status === 'active') {
    await deliverToConversation(row.session_id, {
      kind: 'continue',
      botId: bot.id,
      note: copy.continueAfterTablesPlan(locale, { summary, ...counts, error: outcome.error, created, problems }),
      eventText,
      event,
    });
  } else {
    await deliverToConversation(row.session_id, { kind: 'event', text: eventText, event });
  }
  return settled;
}

async function decideComputer(db: DatabaseProvider, row: BotRequestRow, decision: BotRequestDecision) {
  // The computer layer fills the secure sign-in / hands the screen back and
  // wakes the Bot. Whether or not it settles the row itself, it ends settled.
  if (row.kind === 'login') {
    try {
      await handleLoginDecision({ userId: row.user_id, request: row, decision });
    } catch (error) {
      // The page left, the site changed, no fields: nothing was filled and the
      // request stays pending, so the card can offer a retry or the computer.
      // The message is written for the member and never carries a value.
      if (error instanceof SecureLoginError) throw new RequestDecisionError(409, error.message, error.code);
      throw error;
    }
  } else await handleTakeoverDecision({ userId: row.user_id, request: row, decision });
  const latest = await db.bots.getRequest(row.user_id, row.id);
  if (latest && latest.status === 'pending') {
    return (
      (await db.bots.settleRequest(row.user_id, row.id, decision.decision === 'deny' ? 'denied' : 'resolved', {
        decision: decision.decision,
      })) ?? latest
    );
  }
  return latest ?? row;
}

/** Apply the member's decision on one of their own requests. */
export async function decideBotRequest(
  userId: string,
  requestId: string,
  rawDecision: unknown,
  db: DatabaseProvider = getDb(),
): Promise<BotRequestRow> {
  const decision = parseDecision(rawDecision);
  const row = await db.bots.getRequest(userId, requestId);
  if (!row) throw new RequestDecisionError(404, 'Request not found');
  if ((await db.bots.getConversation(userId, row.session_id))?.kind === 'group') {
    // Group chats are retired: nothing runs there, so no card of one can take
    // effect. Withdraw it if it is still open (migration 0015 cancelled the
    // ones that existed) so it stops asking.
    if (
      row.status === 'pending' &&
      (await db.bots.settleRequest(userId, row.id, 'canceled', { decision: 'group_closed' }))
    ) {
      resolveApprovalWaiter(row.id, 'deny');
      await pushAttention(db, userId);
    }
    throw new RequestDecisionError(409, 'Group chats are retired — this card can no longer be decided', 'group_closed');
  }
  if (row.status !== 'pending')
    throw new RequestDecisionError(409, 'This request was already decided', 'already_decided');
  if (inFlight.has(row.id)) throw new RequestDecisionError(409, 'This request is being decided', 'deciding');
  inFlight.add(row.id);
  try {
    let settled: BotRequestRow;
    switch (row.kind) {
      case 'approval': {
        settled = await settle(db, row, decision.decision === 'deny' ? 'denied' : 'resolved', {
          decision: decision.decision,
        });
        resolveApprovalWaiter(row.id, decision.decision === 'deny' ? 'deny' : decision.decision);
        break;
      }
      case 'bot_create':
        settled = await decideBotCreate(db, row, decision);
        break;
      case 'task_start':
        settled = await decideTaskStart(db, row, decision);
        break;
      case 'instructions_update':
        settled = await decideInstructionsUpdate(db, row, decision);
        break;
      case 'tables_plan':
        settled = await decideTablesPlan(db, row, decision);
        break;
      case 'login':
      case 'takeover':
        settled = await decideComputer(db, row, decision);
        break;
    }
    logger.info('[bots] request decided', {
      requestId: row.id,
      kind: row.kind,
      decision: decision.decision,
      subject: requestSubject(row.kind, safeJsonParse(row.payload, {}) as never).slice(0, 80),
    });
    await pushAttention(db, userId);
    connectionManager.sendToUser(userId, { type: 'bots:conversation', sessionId: row.session_id });
    return settled;
  } finally {
    inFlight.delete(row.id);
  }
}
