/**
 * The one engine for conversations. A conversation has a single writer: at most one turn answers
 * at a time (runs_one_active_turn_key), and what arrives meanwhile waits in conversation_inbox.
 * Finishing a turn and taking the next item happen under the conversation row lock, the same lock
 * a new message takes, so nothing is ever left waiting with no turn to answer it.
 *
 * Every turn is a run (kind `turn`) with a lease. A process that dies leaves an expired lease;
 * the sweep marks that turn interrupted and carries on with the queue.
 */

import { createHash, randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';
import {
  collect,
  createCollector,
  providerOptionsFor,
  streamLoop,
  withFinalAnswer,
  type EngineContentPart,
  type LoopInput,
  type ToolCallRecord,
} from '@greenhouse/agent-core';
import type {
  EditMessageResult,
  RealtimeEvent,
  RegenerateResult,
  SendMessageResult,
  sendMessageInputSchema,
} from '@greenhouse/contract';
import {
  agents,
  conversationAgents,
  conversationInbox,
  requests as requestsTable,
  runSteps,
  conversationMembers,
  conversations,
  getDb,
  handoffs,
  members,
  messageReceipts,
  messages,
  newId,
  runs,
  transaction,
  type Conversation as ConversationRow,
  type Db,
  type NeedsYouRequest,
  type Message as MessageRow,
  type MessageStep,
  type Run,
} from '@greenhouse/db';
import { admitRichBlocks, DEFAULT_CLIENT_BLOCKS } from '@greenhouse/types/rich-output';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import type { z } from 'zod';
import { ApiError, conflict, forbidden, invalidInput, notFound } from '../http/errors.js';
import type { ProvidersService } from '../providers/service.js';
import type { Hub } from '../realtime/hub.js';
import type { AgentsService, TurnAgent } from '../modules/agents/service.js';
import type { FilesService } from '../modules/files/service.js';
import type { NotificationsService } from '../modules/notifications/service.js';
import type { RequestsService } from '../modules/requests/service.js';
import type { SkillsService } from '../modules/skills/service.js';
import { createBackground, type Background } from './background.js';
import { toMessage, type ConversationsService } from '../modules/conversations/service.js';
import { effectiveModules } from '../modules/members/service.js';
import { createDigester, parseStoredDigest, renderDigest } from './digest.js';
import { closeTranscript, projectHistory, withShownImages } from './history.js';
import { createKeyedLock } from './locks.js';
import { createSources } from './sources.js';
import {
  assembleSystem,
  buildAbout,
  buildDigest,
  buildIdentity,
  buildInstruction,
  buildRules,
  buildTail,
  renderMemoryIndex,
  type Locale,
  type TurnReason,
} from './prompt.js';
import { assembleTools } from './tools/assemble.js';
import type { DecisionOutcome, ToolContext, ToolDef } from './tools/define.js';

type SendInput = z.output<typeof sendMessageInputSchema>;

/** What a turn is for, stored on its run. */
export interface TurnInput {
  reason: 'message' | 'mention' | 'continue' | 'handoff';
  message_ids: string[];
  note?: string;
  /** A hand-off: who handed the work over, and the chain it belongs to (for the limits). */
  handoff_id?: string;
  from_agent_id?: string;
  chain?: HandoffChain;
  /** The Agent version the turn ran on, recorded when it starts (feedback names it). */
  agent_version?: number;
  [key: string]: unknown;
}

/** What an edit or a regenerate took out of the transcript, for the events after commit. */
interface Removed {
  ids: string[];
  runIds: string[];
  expired: NeedsYouRequest[];
  closed: Run[];
}

/** The hand-offs that started from one member request: the Agents it went through, in order. */
export interface HandoffChain {
  key: string;
  path: string[];
}

interface InboxPayload {
  agent_id: string;
  member_id: string;
  message_id?: string;
  note?: string;
  handoff_id?: string;
  from_agent_id?: string;
  chain?: HandoffChain;
}

export const HANDOFF_MAX_DEPTH = 3;
export const HANDOFF_MAX_PER_CHAIN = 6;

export interface EngineDeps {
  agents: AgentsService;
  conversations: ConversationsService;
  providers: ProvidersService;
  requests: RequestsService;
  files: FilesService;
  hub: Hub;
  notifications: NotificationsService;
  /** Checks a skill run with `/` before its message is sent. */
  skills: Pick<SkillsService, 'prepareRun'>;
  /** Built on first use, with the engine's background runs and hand-offs at hand. */
  tools: (engine: { background: Background; handOff: Engine['handOff'] }) => readonly ToolDef[];
  /** Replaces model resolution (tests). */
  languageModel?: ProvidersService['languageModel'];
}

const MAX_INLINE_IMAGES = 4;
const MAX_INLINE_IMAGE_BYTES = 5 * 1024 * 1024;
const LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const FLUSH_MS = 1_000;
const SWEEP_MS = 15_000;

const FAILURE_TEXT: Record<Locale, Record<string, string>> = {
  zh: {
    llm_not_configured: '还没有可用的模型服务，请管理员在「管理 → 服务」里配置。',
    model_unavailable: '这段对话选的模型不可用了，请换一个模型。',
    budget_exceeded: '本月的用量预算已经用完了，请联系管理员。',
    agent_paused: '这个 Agent 已被管理员暂停。',
    agent_unavailable: '这个 Agent 已经不再共享给你了。',
    interrupted: '回复被中断了，请再发一次。',
    default: '这次没能完成回复，请稍后再试。',
  },
  en: {
    llm_not_configured: 'No model service is set up yet. An admin can add one under Admin → Services.',
    model_unavailable: 'The model chosen for this conversation is no longer available. Pick another one.',
    budget_exceeded: "This month's usage budget is used up. Ask an admin.",
    agent_paused: 'An admin paused this Agent.',
    agent_unavailable: 'This Agent is no longer shared with you.',
    interrupted: 'The reply was interrupted. Please send it again.',
    default: 'This reply could not be finished. Please try again later.',
  },
};

/** A time zone Postgres and Intl both know, else UTC. */
function zoneOf(timezone: string | null | undefined): string {
  try {
    if (timezone) new Intl.DateTimeFormat('en', { timeZone: timezone });
    return timezone || 'UTC';
  } catch {
    return 'UTC';
  }
}

const localeOf = (value: string | null | undefined): Locale => (value === 'en' ? 'en' : 'zh');

function stepSummary(call: ToolCallRecord, defs: Map<string, ToolDef>, locale: Locale): string {
  const def = defs.get(call.tool);
  try {
    return def?.summarize?.(call.input as never, call.output, locale) ?? call.tool;
  } catch {
    return call.tool;
  }
}

export function createEngine(deps: EngineDeps) {
  const instance = `api-${randomUUID().slice(0, 8)}`;
  const live = new Map<string, AbortController>();
  const inFlight = new Set<Promise<void>>();
  const withConversation = createKeyedLock();
  const languageModel = deps.languageModel ?? deps.providers.languageModel;
  let tools: readonly ToolDef[] | null = null;
  let stopping = false;
  let sweeper: NodeJS.Timeout | null = null;

  const toolDefs = (): readonly ToolDef[] =>
    (tools ??= deps.tools({ background, handOff: (input) => engine.handOff(input) }));
  const digester = createDigester({ languageModel });

  const publish = (conversationId: string, event: RealtimeEvent) => deps.conversations.publish(conversationId, event);

  function track(work: Promise<void>) {
    const tracked = work.catch((error: unknown) => {
      logger.error('[engine] a turn chain failed', error);
    });
    inFlight.add(tracked);
    void tracked.finally(() => inFlight.delete(tracked));
  }

  async function activeTurn(db: Db, conversationId: string): Promise<Run | undefined> {
    const [row] = await db
      .select()
      .from(runs)
      .where(
        and(
          eq(runs.conversationId, conversationId),
          eq(runs.kind, 'turn'),
          inArray(runs.status, ['queued', 'running']),
        ),
      );
    return row;
  }

  /** A new running turn, leased to this process. The caller holds the conversation row lock. */
  async function createTurn(
    db: Db,
    values: { conversationId: string; agentId: string; ownerId: string; input: TurnInput },
  ): Promise<Run> {
    const now = Date.now();
    const [row] = await db
      .insert(runs)
      .values({
        id: newId('run'),
        agentId: values.agentId,
        ownerId: values.ownerId,
        requestedBy: values.ownerId,
        kind: 'turn',
        source: 'conversation',
        sourceId: values.conversationId,
        conversationId: values.conversationId,
        status: 'running',
        leaseOwner: instance,
        leaseExpiresAt: new Date(now + LEASE_MS).toISOString(),
        heartbeatAt: new Date(now).toISOString(),
        startedAt: new Date(now).toISOString(),
        input: values.input,
      })
      .returning();
    return row!;
  }

  /**
   * Ends a run and, under the conversation lock, takes what waits in the inbox: the next turn
   * answers every queued message from the same person to the same Agent at once.
   */
  async function finishAndTakeNext(
    run: Run,
    outcome: { status: Run['status']; errorCode?: string; errorMessage?: string },
  ): Promise<Run | null> {
    return withConversation(run.conversationId!, () =>
      transaction(async (db) => {
        await db
          .select({ id: conversations.id })
          .from(conversations)
          .where(eq(conversations.id, run.conversationId!))
          .for('update');
        // A card can be decided before its turn got here (a quick hand-back); then nothing is left to wait for.
        let status = outcome.status;
        if (status === 'waiting') {
          const [open] = await db
            .select({ id: requestsTable.id })
            .from(requestsTable)
            .where(and(eq(requestsTable.runId, run.id), eq(requestsTable.status, 'pending')))
            .limit(1);
          if (!open) status = 'succeeded';
        }
        await db
          .update(runs)
          .set({
            status,
            errorCode: outcome.errorCode ?? null,
            errorMessage: outcome.errorMessage ?? null,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: status === 'waiting' ? null : sql`now()`,
            waitReason: status === 'waiting' ? 'request' : null,
            updatedAt: sql`now()`,
          })
          .where(eq(runs.id, run.id));
        if (stopping) return null;
        return takeNext(db, run.conversationId!);
      }),
    );
  }

  /** Starts the next turn from the inbox, if any. The caller holds the conversation row lock. */
  async function takeNext(db: Db, conversationId: string): Promise<Run | null> {
    if (await activeTurn(db, conversationId)) return null;
    const pending = await db
      .select()
      .from(conversationInbox)
      .where(and(eq(conversationInbox.conversationId, conversationId), isNull(conversationInbox.consumedAt)))
      .orderBy(asc(conversationInbox.id))
      .limit(50);
    const first = pending[0];
    if (!first) return null;
    const head = first.payload as unknown as InboxPayload;
    const batch =
      first.kind === 'continue'
        ? [first]
        : pending.filter((item) => {
            const payload = item.payload as unknown as InboxPayload;
            return (
              item.kind === first.kind && payload.agent_id === head.agent_id && payload.member_id === head.member_id
            );
          });
    await db
      .update(conversationInbox)
      .set({ consumedAt: sql`now()` })
      .where(
        inArray(
          conversationInbox.id,
          batch.map((item) => item.id),
        ),
      );
    const input: TurnInput =
      first.kind === 'continue'
        ? head.handoff_id
          ? {
              reason: 'handoff',
              message_ids: [],
              note: head.note ?? '',
              handoff_id: head.handoff_id,
              ...(head.from_agent_id ? { from_agent_id: head.from_agent_id } : {}),
              ...(head.chain ? { chain: head.chain } : {}),
            }
          : { reason: 'continue', message_ids: [], note: head.note ?? '' }
        : {
            reason: first.kind === 'mention' ? 'mention' : 'message',
            message_ids: batch.map((item) => (item.payload as unknown as InboxPayload).message_id!).filter(Boolean),
          };
    return createTurn(db, { conversationId, agentId: head.agent_id, ownerId: head.member_id, input });
  }

  async function runChain(first: Run): Promise<void> {
    let next: Run | null = first;
    while (next) next = await runTurn(next);
  }

  async function finishReceipts(run: Run, status: 'answered' | 'failed' | 'canceled') {
    const ids = (run.input as TurnInput).message_ids ?? [];
    if (!ids.length) return;
    await getDb()
      .update(messageReceipts)
      .set({ status, processedAt: sql`now()` })
      .where(and(inArray(messageReceipts.messageId, ids), eq(messageReceipts.agentId, run.agentId)));
  }

  /** Locks the conversation row, the lock every writer of a conversation takes, and returns it. */
  async function lockConversation(db: Db, conversationId: string): Promise<ConversationRow> {
    const [row] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).for('update');
    if (!row) throw notFound('Conversation');
    return row;
  }

  /**
   * Someone else's public Agent takes a new message, edit or regenerate only while it is still
   * shared with the asker, not paused, and under its daily cap for them: replies counted per asker
   * and day in their time zone. Wake-ups of an exchange already under way are not counted out.
   * The caller holds the conversation row lock, so two requests cannot both take the last one.
   */
  async function admit(db: Db, memberId: string, agentIds: readonly string[]): Promise<void> {
    const others = agentIds.length
      ? await db
          .select({ id: agents.id })
          .from(agents)
          .where(and(inArray(agents.id, [...agentIds]), ne(agents.ownerId, memberId)))
      : [];
    for (const { id: agentId } of others) {
      const loaded = await deps.agents.loadForTurn(memberId, agentId);
      if (!loaded.public?.dailyCap) continue;
      const [member] = await db.select({ timezone: members.timezone }).from(members).where(eq(members.id, memberId));
      const zone = zoneOf(member?.timezone);
      const [{ n }] = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(runs)
        .where(
          and(
            eq(runs.kind, 'turn'),
            eq(runs.agentId, agentId),
            eq(runs.ownerId, memberId),
            sql`${runs.createdAt} >= date_trunc('day', now() at time zone ${zone}) at time zone ${zone}`,
            // A turn refused because the Agent was paused or unshared gave no reply.
            sql`not (${runs.status} = 'failed' and coalesce(${runs.errorCode}, '') in ('agent_paused', 'agent_unavailable'))`,
          ),
        )) as [{ n: number }];
      if (n >= loaded.public.dailyCap) {
        throw new ApiError(
          429,
          'daily_cap_reached',
          `You have used today's ${loaded.public.dailyCap} replies from ${loaded.agent.name}. Try again tomorrow.`,
          { daily_cap: loaded.public.dailyCap },
        );
      }
    }
  }

  /**
   * The Agents that answer a member's message. In a room only the sender's own Agents, and only
   * when named (`main` is the sender's main Agent); elsewhere the named ones present, else the
   * conversation's own.
   */
  async function respondersFor(memberId: string, conversation: ConversationRow, mentions: string[]) {
    const present = await deps.conversations.presentAgentIds(conversation);
    const owned = present.length
      ? await getDb()
          .select({ id: agents.id, ownerId: agents.ownerId, archivedAt: agents.archivedAt, isMain: agents.isMain })
          .from(agents)
          .where(inArray(agents.id, present))
      : [];
    const byHandle = (handle: string) =>
      owned.find(
        (agent) =>
          handle === agent.id ||
          handle === `agent:${agent.id}` ||
          (handle === 'main' && agent.isMain && agent.ownerId === memberId),
      );
    const mentioned = [
      ...new Set(
        mentions
          .map(byHandle)
          .filter((agent) => !!agent)
          .map((agent) => agent!.id),
      ),
    ];
    const responders =
      conversation.kind === 'room'
        ? mentioned.filter((id) => owned.find((agent) => agent.id === id)?.ownerId === memberId)
        : mentioned.length
          ? mentioned
          : conversation.agentId
            ? [conversation.agentId]
            : [];
    for (const id of responders) {
      if (owned.find((agent) => agent.id === id)?.archivedAt)
        throw conflict('agent_archived', 'This Agent is archived.');
    }
    return responders;
  }

  /**
   * Hands a member's messages to the Agents that answer them, the same way for a new message and
   * for one answered again: a queued receipt each, then a turn now or a place in the inbox. The
   * caller holds the conversation row lock.
   */
  async function dispatch(
    db: Db,
    conversationId: string,
    work: { memberId: string; messageIds: string[]; agentIds: string[]; kind: 'message' | 'mention' },
  ): Promise<{ run: Run | null; queued: boolean }> {
    let run: Run | null = null;
    let queued = false;
    for (const agentId of work.agentIds) {
      for (const messageId of work.messageIds) {
        await db
          .insert(messageReceipts)
          .values({ messageId, agentId, status: 'queued' })
          .onConflictDoUpdate({
            target: [messageReceipts.messageId, messageReceipts.agentId],
            set: { status: 'queued', processedAt: null },
          });
      }
      if (!run && !(await activeTurn(db, conversationId))) {
        run = await createTurn(db, {
          conversationId,
          agentId,
          ownerId: work.memberId,
          input: { reason: work.kind, message_ids: work.messageIds },
        });
      } else {
        await db.insert(conversationInbox).values(
          work.messageIds.map((messageId) => ({
            conversationId,
            kind: work.kind,
            payload: { message_id: messageId, agent_id: agentId, member_id: work.memberId } satisfies InboxPayload,
          })),
        );
        queued = true;
      }
    }
    return { run, queued };
  }

  /** A wake-up without a member message, into the inbox; it starts now if nothing answers. Under the row lock. */
  async function enqueue(db: Db, conversationId: string, payload: InboxPayload): Promise<Run | null> {
    await db.insert(conversationInbox).values({ conversationId, kind: 'continue', payload: { ...payload } });
    return takeNext(db, conversationId);
  }

  /** Drops what a member queued in a conversation; the receipts of their messages say canceled. */
  async function dropQueued(db: Db, conversationId: string, memberId: string) {
    const queued = await db
      .select()
      .from(conversationInbox)
      .where(and(eq(conversationInbox.conversationId, conversationId), isNull(conversationInbox.consumedAt)));
    const mine = queued.filter((item) => (item.payload as unknown as InboxPayload).member_id === memberId);
    if (!mine.length) return;
    await db
      .update(conversationInbox)
      .set({ consumedAt: sql`now()` })
      .where(
        inArray(
          conversationInbox.id,
          mine.map((item) => item.id),
        ),
      );
    const messageIds = mine
      .map((item) => (item.payload as unknown as InboxPayload).message_id)
      .filter((id): id is string => !!id);
    if (messageIds.length) {
      await db
        .update(messageReceipts)
        .set({ status: 'canceled', processedAt: sql`now()` })
        .where(inArray(messageReceipts.messageId, messageIds));
    }
  }

  /**
   * Cards that expired outside the sweep: their steps are skipped and the runs that waited on them
   * close, without waking the Agent. `runIds` are runs that will not continue in any case.
   */
  async function retire(db: Db, expired: NeedsYouRequest[], runIds: string[]): Promise<Run[]> {
    const stepIds = expired.map((request) => request.stepId).filter((id): id is string => !!id);
    if (stepIds.length) {
      await db
        .update(runSteps)
        .set({ status: 'skipped', finishedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(inArray(runSteps.id, stepIds), eq(runSteps.status, 'pending')));
    }
    const waiting = [
      ...new Set([...runIds, ...expired.map((request) => request.runId).filter((id): id is string => !!id)]),
    ];
    if (!waiting.length) return [];
    const open = new Set(
      (
        await db
          .select({ runId: requestsTable.runId })
          .from(requestsTable)
          .where(and(inArray(requestsTable.runId, waiting), eq(requestsTable.status, 'pending')))
      ).map((row) => row.runId),
    );
    const closable = waiting.filter((id) => !open.has(id));
    if (!closable.length) return [];
    return db
      .update(runs)
      .set({ status: 'canceled', waitReason: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(inArray(runs.id, closable), eq(runs.status, 'waiting')))
      .returning();
  }

  const notLatest = () => conflict('not_latest', 'Only the latest exchange can be edited or regenerated.');

  /**
   * Edit and regenerate change only the member's own latest exchange: every message in `rows` must
   * be a reply of a turn that answered them or an event line of one of their Agents. Anything
   * from someone else (a person, another person's Agent, a background run report) means the
   * conversation moved on.
   */
  async function assertOwnExchange(db: Db, memberId: string, rows: MessageRow[]) {
    if (rows.some((row) => row.role === 'user')) throw notLatest();
    const runIds = [...new Set(rows.map((row) => row.runId).filter((id): id is string => !!id))];
    const agentIds = [...new Set(rows.filter((row) => !row.runId && row.agentId).map((row) => row.agentId!))];
    const turns = runIds.length
      ? await db
          .select({ id: runs.id, kind: runs.kind, ownerId: runs.ownerId })
          .from(runs)
          .where(inArray(runs.id, runIds))
      : [];
    const owners = agentIds.length
      ? await db.select({ id: agents.id, ownerId: agents.ownerId }).from(agents).where(inArray(agents.id, agentIds))
      : [];
    const mine = new Set([
      ...turns.filter((run) => run.kind === 'turn' && run.ownerId === memberId).map((run) => run.id),
      ...owners.filter((agent) => agent.ownerId === memberId).map((agent) => agent.id),
    ]);
    for (const row of rows) {
      if (!mine.has(row.runId ?? row.agentId ?? '')) throw notLatest();
    }
  }

  /**
   * Deletes messages of the latest exchange. Their sequence numbers are never given out again,
   * the cards their turns raised expire, and those turns, if waiting, close. Every later write to
   * a reply is an UPDATE by id, so a stream still running somewhere cannot bring one back.
   */
  async function removeMessages(db: Db, rows: MessageRow[]): Promise<Removed> {
    if (!rows.length) return { ids: [], runIds: [], expired: [], closed: [] };
    const ids = rows.map((row) => row.id);
    const runIds = [...new Set(rows.map((row) => row.runId).filter((id): id is string => !!id))];
    await db.delete(messages).where(inArray(messages.id, ids));
    const expired = await deps.requests.expireOpen({ runIds });
    const closed = await retire(db, expired, runIds);
    return { ids, runIds, expired, closed };
  }

  /** After the commit: what left the transcript, the cards that expired and the runs that closed. */
  async function announceRemoved(conversationId: string, removed: Removed) {
    const people = await deps.conversations.audience(conversationId);
    for (const id of removed.ids) {
      deps.hub.publish(people, { type: 'message.deleted', data: { conversation_id: conversationId, message_id: id } });
    }
    for (const request of removed.expired) deps.requests.announce(request);
    for (const run of removed.closed) {
      deps.hub.publish(people, {
        type: 'run.updated',
        data: { run_id: run.id, status: run.status, conversation_id: conversationId },
      });
    }
    // A turn of a removed reply still streaming here (its lease was taken over) stops now.
    for (const runId of removed.runIds) live.get(runId)?.abort();
  }

  /** A turn started by an edit, a regenerate or a new message: tell everyone, then run it. */
  async function begin(conversationId: string, run: Run | null) {
    if (!run) return;
    await publish(conversationId, {
      type: 'conversation.updated',
      data: { conversation_id: conversationId, changes: { working: true } },
    });
    track(runChain(run));
  }

  /** One turn: build the prompt, stream the reply, persist it, then hand over to the next. */
  async function runTurn(run: Run): Promise<Run | null> {
    const controller = new AbortController();
    live.set(run.id, controller);
    const heartbeat = setInterval(() => {
      void getDb()
        .update(runs)
        .set({ leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(), heartbeatAt: sql`now()` })
        .where(and(eq(runs.id, run.id), eq(runs.leaseOwner, instance)))
        .returning({ desired: runs.desiredState })
        .then(([row]) => {
          // A stop asked for in another process, or the lease was taken over.
          if (!row || row.desired === 'cancel') controller.abort();
        })
        .catch((error: unknown) =>
          logger.warn('[engine] heartbeat failed', { run: run.id, error: toErrorMessage(error) }),
        );
    }, HEARTBEAT_MS);

    const [conversation] = await getDb().select().from(conversations).where(eq(conversations.id, run.conversationId!));
    const [member] = await getDb().select().from(members).where(eq(members.id, run.ownerId));
    const locale = localeOf(member?.locale);
    let reply: MessageRow | null = null;
    let outcome: { status: Run['status']; errorCode?: string; errorMessage?: string } = { status: 'succeeded' };
    let refusal: ApiError | undefined;
    const collector = createCollector();
    const sources = createSources();
    let defs = new Map<string, ToolDef>();

    try {
      if (!conversation || !member) throw new ApiError(410, 'gone', 'The conversation or its member no longer exists.');
      const [seat] = await getDb()
        .select({ id: conversationMembers.memberId })
        .from(conversationMembers)
        .where(
          and(eq(conversationMembers.conversationId, conversation.id), eq(conversationMembers.memberId, run.ownerId)),
        );
      // A turn acts for the member who asked: once they left the conversation, it does not run.
      if (!seat) throw new ApiError(403, 'not_in_conversation', 'The member who asked left this conversation.');
      // The reply exists before the Agent loads, so a public Agent paused meanwhile still says why.
      reply = await withConversation(conversation.id, () =>
        deps.conversations.append(conversation.id, {
          role: 'assistant',
          agentId: run.agentId,
          runId: run.id,
          status: 'streaming',
        }),
      );
      await publish(conversation.id, { type: 'message.created', data: { message: toMessage(reply) } });
      // Someone else's public Agent runs its published version, for the asker (engine/AGENTS.md).
      const loaded: TurnAgent = await deps.agents.loadForTurn(run.ownerId, run.agentId);
      const { agent, manifest } = loaded;
      const shared = loaded.public;
      await getDb()
        .update(runs)
        .set({ input: { ...(run.input as TurnInput), agent_version: loaded.version } })
        .where(eq(runs.id, run.id));

      // A personal key serves only its owner's own Agents.
      const resolved = await languageModel(conversation.model ?? manifest.model, {
        memberId: run.ownerId,
        agentId: agent.id,
        runId: run.id,
        conversationId: conversation.id,
        personal: !shared,
      });

      let tainted = false;
      // Screenshots a tool showed, for the model's next step (only a model that sees images gets any).
      const shown: EngineContentPart[] = [];
      const turnTools = await assembleTools({
        defs: toolDefs(),
        context: {
          memberId: run.ownerId,
          agent,
          manifest,
          conversation,
          runId: run.id,
          locale,
          surface: 'turn',
          signal: controller.signal,
          taint: () => {
            tainted = true;
          },
          tainted: () => tainted,
          cite: sources.cite,
          chain: (run.input as TurnInput).chain ?? { key: run.id, path: [agent.id] },
          ...(resolved.vision
            ? {
                attachImage: (image: Uint8Array, mediaType: string) =>
                  void shown.push({ type: 'image', image, mediaType }),
              }
            : {}),
        },
        availability: {
          memberId: run.ownerId,
          modules: effectiveModules(member.modules),
          manifest,
          surface: 'turn',
          publicAgent: shared ? { computer: shared.computer } : null,
          available: (capability) => deps.providers.available(capability, { memberId: run.ownerId, personal: !shared }),
        },
        raise: (card, stepId) =>
          deps.requests.create({
            memberId: run.ownerId,
            kind: card.kind,
            subject: card.subject,
            title: card.title,
            payload: card.payload,
            conversationId: conversation.id,
            runId: run.id,
            stepId,
            agentId: agent.id,
            ...(card.expiresInMs ? { expiresInMs: card.expiresInMs } : {}),
          }),
        approvalTitle: (summary) =>
          locale === 'zh' ? `${agent.name} 请你批准：${summary}` : `${agent.name} asks to ${summary}`,
      });
      defs = turnTools.defs;

      const projection = await projectHistory({
        conversation,
        agentId: agent.id,
        askerId: run.ownerId,
        excludeMessageId: reply.id,
        contextWindow: resolved.contextWindow,
      });
      // The asker's own memory partition: a public Agent never brings its owner's memories.
      const memories = await deps.agents.memories(run.ownerId, agent.id, 'active');
      const roster = (
        await getDb()
          .select({ id: agents.id, name: agents.name, role: agents.role })
          .from(agents)
          .where(inArray(agents.id, await deps.conversations.presentAgentIds(conversation)))
      ).map((entry) => (entry.id === agent.id ? { id: entry.id, name: agent.name, role: agent.role } : entry));
      const input = run.input as TurnInput;
      const fromName = input.from_agent_id
        ? (await getDb().select({ name: agents.name }).from(agents).where(eq(agents.id, input.from_agent_id)))[0]?.name
        : undefined;
      const reason: TurnReason =
        input.reason === 'handoff'
          ? {
              reason: 'handoff',
              fromName: fromName ?? 'Another Agent',
              memberName: member.name,
              brief: input.note ?? '',
            }
          : input.reason === 'continue'
            ? { reason: 'continue', note: input.note ?? '' }
            : input.reason === 'mention'
              ? { reason: 'mention', memberName: member.name }
              : { reason: 'message', memberName: member.name, count: Math.max(1, input.message_ids.length) };
      const has = (name: string) => turnTools.names.has(name);
      // Teach the blocks the newest screen that wrote here can draw; without a word, the five every client draws.
      const [declared] = await getDb()
        .select({ richBlocks: messages.richBlocks })
        .from(messages)
        .where(
          and(eq(messages.conversationId, conversation.id), eq(messages.role, 'user'), isNotNull(messages.richBlocks)),
        )
        .orderBy(desc(messages.seq))
        .limit(1);
      const system = assembleSystem([
        buildRules(
          {
            computer: has('computer'),
            handoff: has('handoff'),
            memory: has('memory'),
            approvals: [...turnTools.defs.values()].some((def) => def.risk !== 'read'),
            ask: has('ask_user'),
            self: has('self'),
            search: has('web_search'),
            background: has('run_start'),
            browser: has('browser'),
            vault: has('vault'),
            skills: has('skill_query'),
            saveSkill: has('skill_mutation'),
          },
          locale,
          conversation.kind,
          declared?.richBlocks ?? DEFAULT_CLIENT_BLOCKS,
          !!shared,
        ),
        buildIdentity(
          { name: agent.name, role: agent.role, instructions: manifest.instructions },
          member.name,
          shared?.ownerName,
        ),
        buildAbout(member.name, member.about),
        buildDigest(
          (() => {
            const doc = parseStoredDigest(conversation.digest);
            return doc ? renderDigest(doc, locale, new Map(roster.map((entry) => [entry.id, entry.name]))) : '';
          })(),
        ),
      ]);
      const tail = buildTail({
        roster: roster.map((entry) => ({ name: entry.name, role: entry.role, self: entry.id === agent.id })),
        memoryIndex: renderMemoryIndex(
          memories.map((memory) => ({ id: memory.id, title: memory.title, pinned: memory.pinned })),
          locale,
        ),
        instruction: buildInstruction(reason),
      });
      const loopInput: LoopInput = {
        model: { model: resolved.model, modelId: resolved.modelId, deepseek: resolved.deepseek },
        instructions: system,
        messages: closeTranscript(projection.messages, tail, resolved.vision ? await imagesOf(run, input) : []),
        tools: turnTools.tools,
        abortSignal: controller.signal,
        stopWhen: [() => turnTools.waiting() || turnTools.ended()],
        prepareStepMessages: ({ messages: stepMessages }) => withShownImages(stepMessages, shown.splice(0)),
        timeContext: { timezone: member.timezone },
        traceId: run.id,
      };

      const { result } = streamLoop(loopInput);
      let flushedAt = Date.now();
      let flushedLength = 0;
      for await (const part of withFinalAnswer(result, loopInput)) {
        // A refusal of ours (a budget used up) keeps its code for the reply and the run.
        if (part.type === 'error' && part.error instanceof ApiError) refusal ??= part.error;
        const call = collect(part, collector);
        if (part.type === 'text-delta' && part.text) {
          await publish(conversation.id, {
            type: 'message.delta',
            data: {
              conversation_id: conversation.id,
              message_id: reply.id,
              text: part.text,
              offset: collector.text.length - part.text.length,
            },
          });
          if (Date.now() - flushedAt > FLUSH_MS && collector.text.length > flushedLength) {
            // Partial text survives a reload and a crash.
            flushedAt = Date.now();
            flushedLength = collector.text.length;
            await getDb().update(messages).set({ content: collector.text }).where(eq(messages.id, reply.id));
          }
        }
        if (call) {
          await publish(conversation.id, {
            type: 'message.step',
            data: {
              conversation_id: conversation.id,
              message_id: reply.id,
              step: {
                id: call.id,
                tool: call.tool,
                summary: stepSummary(call, defs, locale),
                status: call.status,
                ...(call.durationMs !== undefined ? { duration_ms: call.durationMs } : {}),
              },
            },
          });
        }
      }
      if (collector.aborted || controller.signal.aborted) {
        const [state] = await getDb().select({ desired: runs.desiredState }).from(runs).where(eq(runs.id, run.id));
        outcome =
          state?.desired === 'cancel' || stopping
            ? { status: 'canceled' }
            : { status: 'failed', errorCode: 'timeout', errorMessage: 'The reply took too long.' };
      } else if (collector.error) {
        outcome = {
          status: 'failed',
          errorCode: refusal?.code ?? 'model_error',
          errorMessage: collector.error.slice(0, 500),
        };
      } else if (turnTools.waiting()) {
        outcome = { status: 'waiting' };
      }
    } catch (error) {
      const code = error instanceof ApiError ? error.code : 'internal';
      if (!(error instanceof ApiError))
        logger.error('[engine] turn failed', { run: run.id, error: toErrorMessage(error) });
      outcome = { status: 'failed', errorCode: code, errorMessage: toErrorMessage(error).slice(0, 500) };
    } finally {
      clearInterval(heartbeat);
      live.delete(run.id);
    }

    // An edit or a regenerate removed the reply while it was still being written (its lease was
    // taken over): the turn that answers again owns the receipts and the hand-off from here.
    let superseded = false;
    if (reply && conversation) {
      const failed = outcome.status === 'failed';
      const steps: MessageStep[] = collector.calls
        .filter((call) => call.status !== 'running')
        .map((call) => ({
          tool: call.tool,
          summary: stepSummary(call, defs, locale),
          status: call.status === 'failed' ? 'failed' : 'done',
          ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
        }));
      const content =
        collector.text.trim() ||
        (failed ? (FAILURE_TEXT[locale][outcome.errorCode ?? ''] ?? FAILURE_TEXT[locale].default!) : collector.text);
      const [saved] = await getDb()
        .update(messages)
        .set({
          content,
          steps,
          citations: failed ? [] : sources.citations(content),
          reasoning: collector.reasoning || null,
          status: outcome.status === 'canceled' ? 'stopped' : failed ? 'failed' : 'complete',
        })
        .where(eq(messages.id, reply.id))
        .returning();
      if (saved) await publish(conversation.id, { type: 'message.updated', data: { message: toMessage(saved) } });
      else superseded = true;
      await deps.agents.touch(run.agentId);
    }
    if (!superseded) {
      await finishReceipts(
        run,
        outcome.status === 'canceled' ? 'canceled' : outcome.status === 'failed' ? 'failed' : 'answered',
      );
    }
    const handoffId = (run.input as TurnInput).handoff_id;
    if (handoffId && !superseded) {
      await getDb()
        .update(handoffs)
        .set({
          status: outcome.status === 'failed' ? 'failed' : outcome.status === 'canceled' ? 'canceled' : 'replied',
          runId: run.id,
          reply: collector.text.slice(0, 2000) || null,
          returnedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(handoffs.id, handoffId));
    }
    const next = await finishAndTakeNext(run, outcome);
    if (conversation) {
      await publish(conversation.id, {
        type: 'run.updated',
        data: { run_id: run.id, status: outcome.status, conversation_id: conversation.id },
      });
      if (!next && !(await activeTurn(getDb(), conversation.id))) {
        await publish(conversation.id, {
          type: 'conversation.updated',
          data: { conversation_id: conversation.id, changes: { working: false } },
        });
        // The conversation is idle: fold older messages into the summary if it has grown long.
        track(digester.run(conversation.id));
      }
      if (conversation.kind === 'chat' && !conversation.title && outcome.status !== 'failed') {
        await nameChat(conversation.id, run).catch((error: unknown) =>
          logger.warn('[engine] could not name a chat', { error: toErrorMessage(error) }),
        );
      }
    }
    return next;
  }

  /** A new chat gets a short title from its first exchange, written by the fast model. */
  async function nameChat(conversationId: string, run: Run) {
    const rows = await getDb()
      .select({ role: messages.role, content: messages.content })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), inArray(messages.role, ['user', 'assistant'])))
      .orderBy(asc(messages.seq))
      .limit(2);
    const first = rows.find((row) => row.role === 'user')?.content.trim();
    if (!first) return;
    const resolved = await languageModel('fast', {
      memberId: run.ownerId,
      agentId: run.agentId,
      runId: run.id,
      conversationId,
    });
    const providerOptions = providerOptionsFor(
      { model: resolved.model, modelId: resolved.modelId, deepseek: resolved.deepseek },
      false,
    );
    const { text } = await generateText({
      model: resolved.model,
      system:
        'Write a title for this conversation: at most 12 Chinese characters or 6 English words, in the language of the message, no quotes, no punctuation at the end. Reply with the title only.',
      prompt: rows.map((row) => `${row.role}: ${row.content.slice(0, 1000)}`).join('\n\n'),
      maxOutputTokens: 40,
      ...(providerOptions ? { providerOptions } : {}),
    });
    const title = text
      .replace(/["“”'《》]/g, '')
      .split('\n')[0]!
      .trim()
      .slice(0, 60);
    if (!title) return;
    const [updated] = await getDb()
      .update(conversations)
      .set({ title })
      .where(and(eq(conversations.id, conversationId), eq(conversations.title, '')))
      .returning({ id: conversations.id });
    if (updated)
      await publish(conversationId, {
        type: 'conversation.updated',
        data: { conversation_id: conversationId, changes: { title } },
      });
  }

  /** Images sent with the messages this turn answers, for a model that can see them. */
  async function imagesOf(run: Run, input: TurnInput): Promise<EngineContentPart[]> {
    if (!input.message_ids.length) return [];
    const rows = await getDb()
      .select({ attachments: messages.attachments })
      .from(messages)
      .where(inArray(messages.id, input.message_ids));
    const ids = rows.flatMap((row) => row.attachments);
    const parts: EngineContentPart[] = [];
    for (const id of ids) {
      if (parts.length >= MAX_INLINE_IMAGES) break;
      try {
        const file = await deps.files.get(run.ownerId, id);
        if (!file.contentType.startsWith('image/') || file.sizeBytes > MAX_INLINE_IMAGE_BYTES) continue;
        const { bytes } = await deps.files.bytes(run.ownerId, id);
        parts.push({ type: 'image', image: bytes, mediaType: file.contentType });
      } catch (error) {
        logger.warn('[engine] could not inline an image', { file: id, error: toErrorMessage(error) });
      }
    }
    return parts;
  }

  /** A result as a short line the Agent can read. */
  function brief(value: unknown): string {
    let text: string;
    try {
      text = typeof value === 'string' ? value : JSON.stringify(value);
    } catch {
      text = String(value);
    }
    return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
  }

  /** An approved write runs exactly the arguments the member saw, with the asker's rights. */
  async function decideToolWrite(
    request: NeedsYouRequest,
    run: Run | undefined,
    locale: Locale,
  ): Promise<DecisionOutcome> {
    const payload = request.payload as { tool?: string; input?: unknown; summary?: string };
    const summary = payload.summary ?? payload.tool ?? '';
    const zh = locale === 'zh';
    const setStep = (values: Record<string, unknown>) =>
      request.stepId
        ? getDb()
            .update(runSteps)
            .set({ ...values, updatedAt: sql`now()` } as never)
            .where(eq(runSteps.id, request.stepId))
        : Promise.resolve();
    if (request.status !== 'approved') {
      await setStep({ status: 'skipped', finishedAt: sql`now()` });
      if (request.status === 'rejected') {
        const reason =
          typeof request.result?.reason === 'string' && request.result.reason ? `: ${request.result.reason}` : '';
        return {
          line: zh ? `已拒绝：${summary}` : `Declined: ${summary}`,
          note: `The member declined "${summary}"${reason}. Do not retry unless they ask.`,
        };
      }
      return { line: zh ? `卡片已过期：${summary}` : `Card expired: ${summary}`, note: null };
    }
    const def = toolDefs().find((candidate) => candidate.name === payload.tool);
    // The same Agent the turn ran on; a public Agent paused or unshared meanwhile does not act.
    const loaded = run ? await deps.agents.loadForTurn(run.ownerId, run.agentId).catch(() => null) : null;
    if (!def || !run || !loaded || (loaded.public && !def.publicAgent)) {
      await setStep({ status: 'failed', error: { code: 'tool_gone', message: 'The tool is no longer available.' } });
      return {
        line: zh ? `已批准：${summary}，但无法执行` : `Approved: ${summary}, but it could not run`,
        note: `The member approved "${summary}", but the tool is no longer available.`,
      };
    }
    const { agent, manifest } = loaded;
    const [conversation] = run.conversationId
      ? await getDb().select().from(conversations).where(eq(conversations.id, run.conversationId))
      : [];
    const context: ToolContext = {
      memberId: run.ownerId,
      agent,
      manifest,
      conversation: conversation ?? null,
      runId: run.id,
      stepId: request.stepId ?? '',
      locale,
      surface: 'turn',
      signal: new AbortController().signal,
      taint: () => undefined,
      tainted: () => false,
      raise: () => Promise.reject(new Error('An approved action cannot raise another card.')),
      endTurn: () => undefined,
      approved: true,
    };
    const started = Date.now();
    try {
      const output = await def.execute(payload.input, context);
      await setStep({
        status: 'succeeded',
        output: output ?? null,
        durationMs: Date.now() - started,
        finishedAt: sql`now()`,
      });
      return {
        line: zh ? `已批准：${summary}` : `Approved: ${summary}`,
        note: `The member approved "${summary}" and it ran. Result: ${brief(output)}`,
      };
    } catch (error) {
      const message = toErrorMessage(error).slice(0, 500);
      await setStep({ status: 'failed', error: { code: 'tool_failed', message }, finishedAt: sql`now()` });
      return {
        line: zh ? `已批准：${summary}，但没有成功` : `Approved: ${summary}, but it failed`,
        note: `The member approved "${summary}", but it failed: ${message}`,
      };
    }
  }

  /**
   * What a decision does: runs an approved write or lets the tool apply its proposal, writes one
   * line in the transcript, ends the run that waited for it, and wakes the Agent with the outcome.
   */
  async function resolve(request: NeedsYouRequest): Promise<void> {
    const [run] = request.runId ? await getDb().select().from(runs).where(eq(runs.id, request.runId)) : [];
    const [member] = await getDb()
      .select({ locale: members.locale })
      .from(members)
      .where(eq(members.id, request.memberId));
    const locale = localeOf(member?.locale);
    const agentId = request.agentId ?? run?.agentId ?? null;
    let outcome: DecisionOutcome;
    if (request.subject === 'tool_write') {
      outcome = await decideToolWrite(request, run, locale);
    } else {
      const def = toolDefs().find((candidate) => candidate.name === request.payload.tool);
      const [agent] = agentId ? await getDb().select().from(agents).where(eq(agents.id, agentId)) : [];
      outcome =
        def?.decide && agent
          ? await def.decide(request, { memberId: request.memberId, agent, locale })
          : { line: request.status, note: null };
    }

    if (request.conversationId) {
      const line = await withConversation(request.conversationId, () =>
        deps.conversations.append(request.conversationId!, {
          role: 'event',
          agentId,
          content: outcome.line,
          event: { type: 'decision', request_id: request.id, status: request.status },
        }),
      );
      await publish(request.conversationId, { type: 'message.created', data: { message: toMessage(line) } });
    }

    // The run that waited is done once none of its cards is still open. Under the conversation's
    // row lock, like a turn's finish: whichever comes second sees what the other did.
    if (run?.conversationId) {
      const closed = await withConversation(run.conversationId, () =>
        transaction(async (db) => {
          await lockConversation(db, run.conversationId!);
          const [open] = await db
            .select({ id: requestsTable.id })
            .from(requestsTable)
            .where(and(eq(requestsTable.runId, run.id), eq(requestsTable.status, 'pending')))
            .limit(1);
          if (open) return false;
          const updated = await db
            .update(runs)
            .set({ status: 'succeeded', waitReason: null, finishedAt: sql`now()`, updatedAt: sql`now()` })
            .where(and(eq(runs.id, run.id), eq(runs.status, 'waiting')))
            .returning({ id: runs.id });
          return updated.length > 0;
        }),
      );
      if (closed) {
        await publish(run.conversationId, {
          type: 'run.updated',
          data: { run_id: run.id, status: 'succeeded', conversation_id: run.conversationId },
        });
      }
    }

    if (outcome.note && request.conversationId && agentId) {
      await engine.deliver(request.conversationId, { agentId, memberId: request.memberId, note: outcome.note });
    }
  }

  const background = createBackground({
    instance,
    agents: deps.agents,
    conversations: deps.conversations,
    providers: deps.providers,
    notifications: deps.notifications,
    hub: deps.hub,
    tools: () => toolDefs(),
    languageModel,
    withConversation,
    publish,
  });

  const engine = {
    instance,
    background,

    /** Carries out a decision the member just made on a card. */
    decide(request: NeedsYouRequest): void {
      track(resolve(request));
    },

    /** A member's message. Starts a turn now, or queues behind the one answering. */
    async post(memberId: string, conversationId: string, input: SendInput): Promise<SendMessageResult> {
      const { conversation } = await deps.conversations.access(memberId, conversationId);
      if (conversation.readOnly) throw conflict('read_only', 'This conversation is read only.');
      if (!input.content.trim() && !input.attachments.length && !input.skill) {
        throw invalidInput('Write a message or attach a file.');
      }
      const responders = await respondersFor(memberId, conversation, input.mentions);
      // A `/` run: a skill that can run for every Agent answering, its fields filled in, pinned to its version.
      const skill = input.skill ? await deps.skills.prepareRun(memberId, input.skill, responders) : null;

      const result = await withConversation(conversationId, () =>
        transaction(async (db) => {
          await lockConversation(db, conversationId);
          await admit(db, memberId, responders);
          await deps.files.attach(memberId, conversationId, input.attachments);
          const message = await deps.conversations.append(conversationId, {
            role: 'user',
            authorMemberId: memberId,
            content: input.content,
            attachments: input.attachments,
            quote: input.quote ? { messageId: input.quote.message_id, text: input.quote.text } : null,
            mentions: input.mentions,
            skill,
            richBlocks: admitRichBlocks(input.rich_blocks) ?? null,
          });
          const dispatched = await dispatch(db, conversationId, {
            memberId,
            messageIds: [message.id],
            agentIds: responders,
            kind: conversation.kind === 'room' ? 'mention' : 'message',
          });
          return { message, ...dispatched };
        }),
      );
      await publish(conversationId, { type: 'message.created', data: { message: toMessage(result.message) } });
      await begin(conversationId, result.run);
      return { message: toMessage(result.message), run_id: result.run?.id ?? null, queued: result.queued };
    },

    /**
     * Edits the member's last message, only while no turn answers (stop first) and only while
     * everything after it is the answer to it. The replies leave the transcript, their cards
     * expire, and the message is answered again through the same path as a new one.
     */
    async edit(
      memberId: string,
      conversationId: string,
      messageId: string,
      content: string,
    ): Promise<EditMessageResult> {
      const { conversation } = await deps.conversations.access(memberId, conversationId);
      if (conversation.readOnly) throw conflict('read_only', 'This conversation is read only.');
      const [target] = await getDb()
        .select()
        .from(messages)
        .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)));
      if (!target) throw notFound('Message');
      if (target.role !== 'user' || target.authorMemberId !== memberId) {
        throw conflict('not_editable', 'Only your own last message can be edited.');
      }
      if (!content.trim() && !target.attachments.length && !target.skill) {
        throw invalidInput('Write a message or attach a file.');
      }
      const responders = await respondersFor(memberId, conversation, target.mentions);

      const result = await withConversation(conversationId, () =>
        transaction(async (db) => {
          const locked = await lockConversation(db, conversationId);
          if (await activeTurn(db, conversationId)) {
            throw conflict('conversation_busy', 'An Agent is answering. Stop it first.');
          }
          await admit(db, memberId, responders);
          const [current] = await db.select().from(messages).where(eq(messages.id, target.id));
          if (!current) throw notFound('Message');
          const after = await db
            .select()
            .from(messages)
            .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, current.seq)))
            .orderBy(asc(messages.seq));
          await assertOwnExchange(db, memberId, after);
          // The summary never folds the last two exchanges; this keeps it from going stale if that changes.
          if (current.seq <= locked.digestUptoSeq)
            throw conflict('message_summarized', 'This part is already summarised.');
          const removed = await removeMessages(db, after);
          const [message] = await db
            .update(messages)
            .set({ content, editedAt: sql`now()` })
            .where(eq(messages.id, current.id))
            .returning();
          await db.delete(messageReceipts).where(eq(messageReceipts.messageId, current.id));
          const dispatched = await dispatch(db, conversationId, {
            memberId,
            messageIds: [current.id],
            agentIds: responders,
            kind: conversation.kind === 'room' ? 'mention' : 'message',
          });
          return { message: message!, removed, ...dispatched };
        }),
      );
      await announceRemoved(conversationId, result.removed);
      await publish(conversationId, { type: 'message.updated', data: { message: toMessage(result.message) } });
      await begin(conversationId, result.run);
      return {
        message: toMessage(result.message),
        deleted_message_ids: result.removed.ids,
        run_id: result.run?.id ?? null,
        queued: result.queued,
      };
    },

    /**
     * Writes the last reply to the member again: it (and the event lines after it) leaves the
     * transcript, its cards expire, and what it answered (the member's messages, or the note
     * that woke the Agent) is queued again for the same Agent.
     */
    async regenerate(memberId: string, conversationId: string, messageId: string): Promise<RegenerateResult> {
      const { conversation } = await deps.conversations.access(memberId, conversationId);
      if (conversation.readOnly) throw conflict('read_only', 'This conversation is read only.');
      const notRegenerable = () =>
        conflict('not_regenerable', 'Only a reply an Agent wrote for you can be regenerated.');

      const result = await withConversation(conversationId, () =>
        transaction(async (db) => {
          const locked = await lockConversation(db, conversationId);
          if (await activeTurn(db, conversationId)) {
            throw conflict('conversation_busy', 'An Agent is answering. Stop it first.');
          }
          const [target] = await db
            .select()
            .from(messages)
            .where(and(eq(messages.id, messageId), eq(messages.conversationId, conversationId)));
          if (!target) throw notFound('Message');
          const [turn] =
            target.role === 'assistant' && target.runId
              ? await db.select().from(runs).where(eq(runs.id, target.runId))
              : [];
          if (!turn || turn.kind !== 'turn' || turn.ownerId !== memberId) throw notRegenerable();
          const after = await db
            .select()
            .from(messages)
            .where(and(eq(messages.conversationId, conversationId), gt(messages.seq, target.seq)))
            .orderBy(asc(messages.seq));
          if (after.some((row) => row.role !== 'event')) throw notLatest();
          await assertOwnExchange(db, memberId, after);
          if (!(await deps.conversations.presentAgentIds(locked)).includes(turn.agentId)) throw notRegenerable();
          const [agent] = await db
            .select({ archivedAt: agents.archivedAt })
            .from(agents)
            .where(eq(agents.id, turn.agentId));
          if (!agent) throw notRegenerable();
          if (agent.archivedAt) throw conflict('agent_archived', 'This Agent is archived.');
          await admit(db, memberId, [turn.agentId]);

          const input = turn.input as TurnInput;
          const asking =
            input.reason === 'message' || input.reason === 'mention'
              ? await db
                  .select({ id: messages.id, seq: messages.seq })
                  .from(messages)
                  .where(and(eq(messages.conversationId, conversationId), inArray(messages.id, input.message_ids)))
                  .orderBy(asc(messages.seq))
              : [];
          if ((input.reason === 'message' || input.reason === 'mention') && !asking.length) throw notRegenerable();
          if ((asking[0]?.seq ?? target.seq) <= locked.digestUptoSeq) {
            throw conflict('message_summarized', 'This part is already summarised.');
          }
          const removed = await removeMessages(db, [target, ...after]);
          if (input.reason === 'message' || input.reason === 'mention') {
            const { run, queued } = await dispatch(db, conversationId, {
              memberId,
              messageIds: asking.map((row) => row.id),
              agentIds: [turn.agentId],
              kind: input.reason,
            });
            return { removed, started: run, mine: run, queued };
          }
          // A turn woken without a message (a decision, a hand-off): the same note wakes it again.
          const ahead = await db
            .select({ id: conversationInbox.id })
            .from(conversationInbox)
            .where(and(eq(conversationInbox.conversationId, conversationId), isNull(conversationInbox.consumedAt)))
            .limit(1);
          const started = await enqueue(db, conversationId, {
            agent_id: turn.agentId,
            member_id: memberId,
            note: input.note ?? '',
            ...(input.handoff_id
              ? {
                  handoff_id: input.handoff_id,
                  ...(input.from_agent_id ? { from_agent_id: input.from_agent_id } : {}),
                  ...(input.chain ? { chain: input.chain } : {}),
                }
              : {}),
          });
          return { removed, started, mine: ahead.length ? null : started, queued: ahead.length > 0 };
        }),
      );
      await announceRemoved(conversationId, result.removed);
      await begin(conversationId, result.started);
      return { deleted_message_ids: result.removed.ids, run_id: result.mine?.id ?? null, queued: result.queued };
    },

    /**
     * An Agent hands part of the work to another of the member's Agents in the same
     * conversation: it joins, answers next with the member's rights, and the hand-off is kept
     * with its chain so a request cannot bounce around forever.
     */
    async handOff(input: {
      conversationId: string;
      fromAgentId: string;
      toAgentId: string;
      memberId: string;
      brief: string;
      chain: HandoffChain;
      locale: Locale;
    }): Promise<{ handoffId: string }> {
      if (input.chain.path.includes(input.toAgentId)) {
        throw new Error('That Agent already worked on this request; hand-offs cannot go in a circle.');
      }
      if (input.chain.path.length > HANDOFF_MAX_DEPTH)
        throw new Error('This request has been handed on too many times.');
      const [{ n }] = (await getDb()
        .select({ n: sql<number>`count(*)::int` })
        .from(handoffs)
        .where(eq(handoffs.chainKey, input.chain.key))) as [{ n: number }];
      if (n >= HANDOFF_MAX_PER_CHAIN) throw new Error('This request has had too many hand-offs.');
      const path = [...input.chain.path, input.toAgentId];
      const dedupeKey = `${input.chain.key}:${input.fromAgentId}>${input.toAgentId}:${createHash('sha256').update(input.brief).digest('hex').slice(0, 16)}`;
      const [row] = await getDb()
        .insert(handoffs)
        .values({
          id: newId('handoff'),
          requestedBy: input.memberId,
          sourceConversationId: input.conversationId,
          sourceAgentId: input.fromAgentId,
          targetConversationId: input.conversationId,
          targetAgentId: input.toAgentId,
          chainKey: input.chain.key,
          path,
          dedupeKey,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) throw new Error('This was already handed over.');
      await getDb()
        .insert(conversationAgents)
        .values({ conversationId: input.conversationId, agentId: input.toAgentId, addedBy: input.memberId })
        .onConflictDoNothing();
      const names = new Map(
        (
          await getDb()
            .select({ id: agents.id, name: agents.name })
            .from(agents)
            .where(inArray(agents.id, [input.fromAgentId, input.toAgentId]))
        ).map((entry) => [entry.id, entry.name]),
      );
      const from = names.get(input.fromAgentId) ?? 'Agent';
      const to = names.get(input.toAgentId) ?? 'Agent';
      const line = await withConversation(input.conversationId, () =>
        deps.conversations.append(input.conversationId, {
          role: 'event',
          agentId: input.fromAgentId,
          content: input.locale === 'zh' ? `${from} 把工作交给了 ${to}` : `${from} handed the work to ${to}`,
          event: { type: 'handoff', handoff_id: row.id, from: input.fromAgentId, to: input.toAgentId },
        }),
      );
      await publish(input.conversationId, { type: 'message.created', data: { message: toMessage(line) } });
      await engine.deliver(input.conversationId, {
        agentId: input.toAgentId,
        memberId: input.memberId,
        note: input.brief,
        handoff: { id: row.id, fromAgentId: input.fromAgentId, chain: { key: input.chain.key, path } },
      });
      return { handoffId: row.id };
    },

    /**
     * Wakes an Agent in a conversation without a member message: a decision on a card, a finished
     * background run, a process that ended. Queued behind a running turn like everything else.
     */
    async deliver(
      conversationId: string,
      item: {
        agentId: string;
        memberId: string;
        note: string;
        handoff?: { id: string; fromAgentId: string; chain: HandoffChain };
      },
    ) {
      const run = await withConversation(conversationId, () =>
        transaction(async (db) => {
          await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .for('update');
          return enqueue(db, conversationId, {
            agent_id: item.agentId,
            member_id: item.memberId,
            note: item.note,
            ...(item.handoff
              ? { handoff_id: item.handoff.id, from_agent_id: item.handoff.fromAgentId, chain: item.handoff.chain }
              : {}),
          });
        }),
      );
      await begin(conversationId, run);
    },

    /** Stops the answering turn at once and drops what the member queued behind it. */
    async stop(memberId: string, conversationId: string): Promise<void> {
      const { conversation } = await deps.conversations.access(memberId, conversationId);
      const active = await activeTurn(getDb(), conversationId);
      if (!active) return;
      if (conversation.kind === 'room' && active.ownerId !== memberId) {
        throw forbidden('Only the person who asked can stop this reply.');
      }
      await withConversation(conversationId, () =>
        transaction(async (db) => {
          await db
            .update(runs)
            .set({ desiredState: 'cancel', updatedAt: sql`now()` })
            .where(eq(runs.id, active.id));
          await dropQueued(db, conversationId, memberId);
        }),
      );
      live.get(active.id)?.abort();
    },

    /**
     * Someone left the conversation or was removed: the reply they asked for stops, what they
     * queued is dropped, and their open cards here expire. (runTurn also refuses to answer anyone
     * no longer in the conversation.)
     */
    async release(conversationId: string, memberId: string): Promise<void> {
      const outcome = await withConversation(conversationId, () =>
        transaction(async (db) => {
          await lockConversation(db, conversationId);
          const active = await activeTurn(db, conversationId);
          const stopping = active?.ownerId === memberId ? active : null;
          if (stopping) {
            await db
              .update(runs)
              .set({ desiredState: 'cancel', updatedAt: sql`now()` })
              .where(eq(runs.id, stopping.id));
          }
          await dropQueued(db, conversationId, memberId);
          const expired = await deps.requests.expireOpen({ memberId, conversationId });
          const closed = await retire(db, expired, []);
          return { stopping, removed: { ids: [], runIds: [], expired, closed } satisfies Removed };
        }),
      );
      if (outcome.stopping) live.get(outcome.stopping.id)?.abort();
      await announceRemoved(conversationId, outcome.removed);
    },

    /**
     * Turns whose process died (expired lease) end as interrupted, keeping what they wrote, and
     * their queue moves on. Queues left behind with no turn (a shutdown) start again.
     */
    async sweep(): Promise<void> {
      for (const request of await deps.requests.expireDue()) track(resolve(request));
      await background.sweep();
      const expired = await getDb()
        .select()
        .from(runs)
        .where(
          and(eq(runs.kind, 'turn'), eq(runs.status, 'running'), lt(runs.leaseExpiresAt, new Date().toISOString())),
        );
      for (const run of expired) {
        if (live.has(run.id)) continue;
        const [streaming] = await getDb()
          .update(messages)
          .set({ status: 'failed' })
          .where(and(eq(messages.runId, run.id), eq(messages.status, 'streaming')))
          .returning();
        if (streaming) {
          const [member] = await getDb()
            .select({ locale: members.locale })
            .from(members)
            .where(eq(members.id, run.ownerId));
          const content = streaming.content.trim() || FAILURE_TEXT[localeOf(member?.locale)].interrupted!;
          const [saved] = await getDb()
            .update(messages)
            .set({ content })
            .where(eq(messages.id, streaming.id))
            .returning();
          await publish(streaming.conversationId, { type: 'message.updated', data: { message: toMessage(saved!) } });
        }
        await finishReceipts(run, 'failed');
        const next = await finishAndTakeNext(run, {
          status: 'failed',
          errorCode: 'interrupted',
          errorMessage: 'The process answering stopped.',
        });
        if (next) track(runChain(next));
      }
      const orphaned = await getDb()
        .selectDistinct({ id: conversationInbox.conversationId })
        .from(conversationInbox)
        .where(isNull(conversationInbox.consumedAt))
        .limit(100);
      for (const { id } of orphaned) {
        const run = await withConversation(id, () =>
          transaction(async (db) => {
            await db.select({ id: conversations.id }).from(conversations).where(eq(conversations.id, id)).for('update');
            return takeNext(db, id);
          }),
        );
        if (run) track(runChain(run));
      }
    },

    start() {
      background.start_worker();
      sweeper ??= setInterval(() => {
        void engine
          .sweep()
          .catch((error: unknown) => logger.warn('[engine] sweep failed', { error: toErrorMessage(error) }));
      }, SWEEP_MS);
    },

    /** Resolves once no turn or background run is running in this process (tests, shutdown). */
    async idle(): Promise<void> {
      while (inFlight.size) {
        await Promise.all([...inFlight]);
        await background.idle();
      }
      await background.idle();
    },

    /** Stops taking new work; running turns are stopped and recorded as such. */
    async shutdown(): Promise<void> {
      stopping = true;
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
      for (const controller of live.values()) controller.abort();
      await background.shutdown();
      await engine.idle();
    },
  };
  return engine;
}

export type Engine = ReturnType<typeof createEngine>;
