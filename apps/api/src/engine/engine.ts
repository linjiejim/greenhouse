/**
 * The one engine for conversations. A conversation has a single writer: at most one turn answers
 * at a time (runs_one_active_turn_key), and what arrives meanwhile waits in conversation_inbox.
 * Finishing a turn and taking the next item happen under the conversation row lock, the same lock
 * a new message takes, so nothing is ever left waiting with no turn to answer it.
 *
 * Every turn is a run (kind `turn`) with a lease. A process that dies leaves an expired lease;
 * the sweep marks that turn interrupted and carries on with the queue.
 */

import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { and, asc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import {
  collect,
  createCollector,
  providerOptionsFor,
  streamLoop,
  withFinalAnswer,
  type LoopInput,
  type ToolCallRecord,
} from '@greenhouse/agent-core';
import type { RealtimeEvent, SendMessageResult, sendMessageInputSchema } from '@greenhouse/contract';
import {
  agents,
  conversationInbox,
  conversationMembers,
  conversations,
  files,
  getDb,
  members,
  messageReceipts,
  messages,
  newId,
  runs,
  transaction,
  type Conversation,
  type Db,
  type Message as MessageRow,
  type MessageStep,
  type Run,
} from '@greenhouse/db';
import { DEFAULT_CLIENT_BLOCKS } from '@greenhouse/types/rich-output';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import type { z } from 'zod';
import { ApiError, conflict, forbidden, invalidInput } from '../http/errors.js';
import type { ProvidersService } from '../providers/service.js';
import type { Hub } from '../realtime/hub.js';
import type { AgentsService } from '../modules/agents/service.js';
import { toMessage, type ConversationsService } from '../modules/conversations/service.js';
import { effectiveModules } from '../modules/members/service.js';
import { projectHistory } from './history.js';
import { createKeyedLock } from './locks.js';
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
import type { ToolDef } from './tools/define.js';

type SendInput = z.output<typeof sendMessageInputSchema>;

/** What a turn is for, stored on its run. */
export interface TurnInput {
  reason: 'message' | 'mention' | 'continue';
  message_ids: string[];
  note?: string;
  [key: string]: unknown;
}

interface InboxPayload {
  agent_id: string;
  member_id: string;
  message_id?: string;
  note?: string;
}

export interface EngineDeps {
  agents: AgentsService;
  conversations: ConversationsService;
  providers: ProvidersService;
  hub: Hub;
  tools: (engine: { deps: EngineDeps }) => readonly ToolDef[];
  /** Replaces model resolution (tests). */
  languageModel?: ProvidersService['languageModel'];
}

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 10_000;
const FLUSH_MS = 1_000;
const SWEEP_MS = 15_000;

const FAILURE_TEXT: Record<Locale, Record<string, string>> = {
  zh: {
    llm_not_configured: '还没有可用的模型服务，请管理员在「管理 → 服务」里配置。',
    model_unavailable: '这段对话选的模型不可用了，请换一个模型。',
    interrupted: '回复被中断了，请再发一次。',
    default: '这次没能完成回复，请稍后再试。',
  },
  en: {
    llm_not_configured: 'No model service is set up yet. An admin can add one under Admin → Services.',
    model_unavailable: 'The model chosen for this conversation is no longer available. Pick another one.',
    interrupted: 'The reply was interrupted. Please send it again.',
    default: 'This reply could not be finished. Please try again later.',
  },
};

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

  const toolDefs = () => (tools ??= deps.tools({ deps }));

  async function audience(conversationId: string): Promise<string[]> {
    const rows = await getDb()
      .select({ id: conversationMembers.memberId })
      .from(conversationMembers)
      .where(eq(conversationMembers.conversationId, conversationId));
    return rows.map((row) => row.id);
  }

  async function publish(conversationId: string, event: RealtimeEvent) {
    deps.hub.publish(await audience(conversationId), event);
  }

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
        await db
          .update(runs)
          .set({
            status: outcome.status,
            errorCode: outcome.errorCode ?? null,
            errorMessage: outcome.errorMessage ?? null,
            leaseOwner: null,
            leaseExpiresAt: null,
            finishedAt: outcome.status === 'waiting' ? null : sql`now()`,
            waitReason: outcome.status === 'waiting' ? 'request' : null,
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
        ? { reason: 'continue', message_ids: [], note: head.note ?? '' }
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
    const collector = createCollector();
    let defs = new Map<string, ToolDef>();

    try {
      if (!conversation || !member) throw new ApiError(410, 'gone', 'The conversation or its member no longer exists.');
      const loaded = await deps.agents.load(run.ownerId, run.agentId);
      const { agent, manifest } = loaded;
      reply = await withConversation(conversation.id, () =>
        deps.conversations.append(conversation.id, {
          role: 'assistant',
          agentId: agent.id,
          runId: run.id,
          status: 'streaming',
        }),
      );
      await publish(conversation.id, { type: 'message.created', data: { message: toMessage(reply) } });

      const resolved = await languageModel(conversation.model ?? manifest.model, {
        memberId: run.ownerId,
        agentId: agent.id,
        runId: run.id,
        conversationId: conversation.id,
        personal: agent.ownerId === run.ownerId,
      });

      let tainted = false;
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
        },
        availability: {
          memberId: run.ownerId,
          modules: effectiveModules(member.modules),
          manifest,
          surface: 'turn',
          available: (capability) => deps.providers.available(capability, { memberId: run.ownerId }),
        },
      });
      defs = turnTools.defs;

      const projection = await projectHistory({
        conversation,
        agentId: agent.id,
        askerId: run.ownerId,
        excludeMessageId: reply.id,
        contextWindow: resolved.contextWindow,
      });
      const memories = await deps.agents.memories(run.ownerId, agent.id, 'active');
      const roster = await getDb()
        .select({ id: agents.id, name: agents.name, role: agents.role })
        .from(agents)
        .where(inArray(agents.id, await deps.conversations.presentAgentIds(conversation)));
      const input = run.input as TurnInput;
      const reason: TurnReason =
        input.reason === 'continue'
          ? { reason: 'continue', note: input.note ?? '' }
          : input.reason === 'mention'
            ? { reason: 'mention', memberName: member.name }
            : { reason: 'message', memberName: member.name, count: Math.max(1, input.message_ids.length) };
      const has = (name: string) => turnTools.names.has(name);
      const system = assembleSystem([
        buildRules(
          {
            memory: has('memory'),
            approvals: [...turnTools.defs.values()].some((def) => def.risk !== 'read'),
            ask: has('ask_user'),
            self: has('self'),
            search: has('web_search'),
            background: has('run_start'),
          },
          locale,
          conversation.kind,
          DEFAULT_CLIENT_BLOCKS,
        ),
        buildIdentity({ name: agent.name, role: agent.role, instructions: manifest.instructions }, member.name),
        buildAbout(member.name, member.about),
        buildDigest(conversation.digest),
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
        messages: [...projection.messages, { role: 'user', content: tail }],
        tools: turnTools.tools,
        abortSignal: controller.signal,
        stopWhen: [() => turnTools.waiting()],
        timeContext: { timezone: member.timezone },
        traceId: run.id,
      };

      const { result } = streamLoop(loopInput);
      let flushedAt = Date.now();
      let flushedLength = 0;
      for await (const part of withFinalAnswer(result, loopInput)) {
        const call = collect(part, collector);
        if (part.type === 'text-delta' && part.text) {
          deps.hub.publish(await audience(conversation.id), {
            type: 'message.delta',
            data: { conversation_id: conversation.id, message_id: reply.id, text: part.text },
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
        outcome = { status: 'failed', errorCode: 'model_error', errorMessage: collector.error.slice(0, 500) };
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
          reasoning: collector.reasoning || null,
          status: outcome.status === 'canceled' ? 'stopped' : failed ? 'failed' : 'complete',
        })
        .where(eq(messages.id, reply.id))
        .returning();
      if (saved) await publish(conversation.id, { type: 'message.updated', data: { message: toMessage(saved) } });
      await deps.agents.touch(run.agentId);
    }
    await finishReceipts(
      run,
      outcome.status === 'canceled' ? 'canceled' : outcome.status === 'failed' ? 'failed' : 'answered',
    );
    const next = await finishAndTakeNext(run, outcome);
    if (conversation) {
      await publish(conversation.id, {
        type: 'run.updated',
        data: { run_id: run.id, status: outcome.status, conversation_id: conversation.id },
      });
      if (!next)
        await publish(conversation.id, {
          type: 'conversation.updated',
          data: { conversation_id: conversation.id, changes: { working: false } },
        });
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

  async function checkAttachments(memberId: string, conversationId: string, ids: string[]) {
    if (!ids.length) return;
    const rows = await getDb()
      .select({ id: files.id, ownerId: files.ownerId, conversationId: files.conversationId, status: files.status })
      .from(files)
      .where(inArray(files.id, ids));
    const ok = rows.filter(
      (row) => row.status === 'active' && (row.ownerId === memberId || row.conversationId === conversationId),
    );
    if (ok.length !== new Set(ids).size) throw invalidInput('Some attachments cannot be used here.');
  }

  const engine = {
    instance,

    /** A member's message. Starts a turn now, or queues behind the one answering. */
    async post(memberId: string, conversationId: string, input: SendInput): Promise<SendMessageResult> {
      const { conversation } = await deps.conversations.access(memberId, conversationId);
      if (conversation.readOnly) throw conflict('read_only', 'This conversation is read only.');
      if (!input.content.trim() && !input.attachments.length) throw invalidInput('Write a message or attach a file.');
      await checkAttachments(memberId, conversationId, input.attachments);

      const present = await deps.conversations.presentAgentIds(conversation);
      const owned = present.length
        ? await getDb()
            .select({ id: agents.id, ownerId: agents.ownerId, archivedAt: agents.archivedAt, isMain: agents.isMain })
            .from(agents)
            .where(inArray(agents.id, present))
        : [];
      const byHandle = (handle: string) =>
        owned.find(
          (agent) => handle === agent.id || handle === `agent:${agent.id}` || (handle === 'main' && agent.isMain),
        );
      const mentioned = [
        ...new Set(
          input.mentions
            .map(byHandle)
            .filter((agent) => !!agent)
            .map((agent) => agent!.id),
        ),
      ];
      let responders: string[];
      if (conversation.kind === 'room') {
        // In a room an Agent answers only its owner, and only when named.
        responders = mentioned.filter((id) => owned.find((agent) => agent.id === id)?.ownerId === memberId);
      } else {
        responders = mentioned.length ? mentioned : conversation.agentId ? [conversation.agentId] : [];
      }
      for (const id of responders) {
        if (owned.find((agent) => agent.id === id)?.archivedAt)
          throw conflict('agent_archived', 'This Agent is archived.');
      }

      const result = await withConversation(conversationId, () =>
        transaction(async (db) => {
          const message = await deps.conversations.append(conversationId, {
            role: 'user',
            authorMemberId: memberId,
            content: input.content,
            attachments: input.attachments,
            quote: input.quote ? { messageId: input.quote.message_id, text: input.quote.text } : null,
            mentions: input.mentions,
            skill: input.skill ? { skillId: input.skill.skill_id, variables: input.skill.variables } : null,
          });
          let run: Run | null = null;
          let queued = false;
          const kind = conversation.kind === 'room' ? 'mention' : 'message';
          for (const agentId of responders) {
            await db.insert(messageReceipts).values({ messageId: message.id, agentId, status: 'queued' });
            if (!run && !(await activeTurn(db, conversationId))) {
              run = await createTurn(db, {
                conversationId,
                agentId,
                ownerId: memberId,
                input: { reason: kind, message_ids: [message.id] },
              });
            } else {
              await db.insert(conversationInbox).values({
                conversationId,
                kind,
                payload: { message_id: message.id, agent_id: agentId, member_id: memberId } satisfies InboxPayload,
              });
              queued = true;
            }
          }
          return { message, run, queued };
        }),
      );
      await publish(conversationId, { type: 'message.created', data: { message: toMessage(result.message) } });
      if (result.run) {
        await publish(conversationId, {
          type: 'conversation.updated',
          data: { conversation_id: conversationId, changes: { working: true } },
        });
        track(runChain(result.run));
      }
      return { message: toMessage(result.message), run_id: result.run?.id ?? null, queued: result.queued };
    },

    /**
     * Wakes an Agent in a conversation without a member message: a decision on a card, a finished
     * background run, a process that ended. Queued behind a running turn like everything else.
     */
    async deliver(conversationId: string, item: { agentId: string; memberId: string; note: string }) {
      const run = await withConversation(conversationId, () =>
        transaction(async (db) => {
          await db
            .select({ id: conversations.id })
            .from(conversations)
            .where(eq(conversations.id, conversationId))
            .for('update');
          await db.insert(conversationInbox).values({
            conversationId,
            kind: 'continue',
            payload: { agent_id: item.agentId, member_id: item.memberId, note: item.note } satisfies InboxPayload,
          });
          return takeNext(db, conversationId);
        }),
      );
      if (run) {
        await publish(conversationId, {
          type: 'conversation.updated',
          data: { conversation_id: conversationId, changes: { working: true } },
        });
        track(runChain(run));
      }
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
          const queued = await db
            .select()
            .from(conversationInbox)
            .where(and(eq(conversationInbox.conversationId, conversationId), isNull(conversationInbox.consumedAt)));
          const mine = queued.filter((item) => (item.payload as unknown as InboxPayload).member_id === memberId);
          if (mine.length) {
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
        }),
      );
      live.get(active.id)?.abort();
    },

    /**
     * Turns whose process died (expired lease) end as interrupted, keeping what they wrote, and
     * their queue moves on. Queues left behind with no turn (a shutdown) start again.
     */
    async sweep(): Promise<void> {
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
      sweeper ??= setInterval(() => {
        void engine
          .sweep()
          .catch((error: unknown) => logger.warn('[engine] sweep failed', { error: toErrorMessage(error) }));
      }, SWEEP_MS);
    },

    /** Resolves once no turn is running in this process (tests, shutdown). */
    async idle(): Promise<void> {
      while (inFlight.size) await Promise.all([...inFlight]);
    },

    /** Stops taking new work; running turns are stopped and recorded as such. */
    async shutdown(): Promise<void> {
      stopping = true;
      if (sweeper) clearInterval(sweeper);
      sweeper = null;
      for (const controller of live.values()) controller.abort();
      await engine.idle();
    },
  };
  return engine;
}

export type Engine = ReturnType<typeof createEngine>;
