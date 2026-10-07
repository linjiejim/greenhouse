/**
 * One Bot turn inside a running Bots chain (spec §4.2–§4.5, design review R4).
 *
 * Builds the turn (context, tools, prompt, projected history), streams it into
 * the run, and persists it on the run's single writer. Differences from the
 * single-agent pump (chat/turn.ts) are deliberate:
 * - the wire `finish` of a turn is swallowed (the chain emits exactly one at the
 *   very end) and a turn's error/abort becomes `bot-turn-end{status}` instead
 *   of a wire `error` — a client treats any `error` as the whole run failing;
 * - the turn has its own abort (chain wall clock / token budget) under the
 *   run's (member Stop, shutdown);
 * - a follow-up's text is held back until it is clearly not `<<skip>>`, so the
 *   member never sees the skip token flash by;
 * - earlier browser/computer observations are stubbed in-turn (context-trim);
 * - a soft stop (`ChatRun.requestInterrupt`) ends the turn at the next step
 *   boundary as `completed`: the step in flight finishes and is saved (a
 *   generated image is not thrown away), no new step starts, and when no
 *   member message waits the saved turn carries the stop notice.
 */

import type { StopCondition, ToolSet } from 'ai';
import {
  buildEngineResult,
  createCollectors,
  processStreamPart,
  resolveHistoryBudget,
  withFinalAnswerGuarantee,
  type EngineMessage,
} from '@greenhouse/agent-core';
import { BotsDomainError, type BotRow, type ConversationWithMembers, type DatabaseProvider } from '@greenhouse/db';
import type { BotEvent, BotRequestKind, BotTurnReason } from '@greenhouse/types/bots';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { safeJsonParse } from '@greenhouse/utils/json';
import type { ToolRegistry } from '../../agent.js';
import type { ChatRun } from '../../chat/runs.js';
import { persistChatResult } from '../../chat/persist.js';
import { chatInterruptionNotice, chatStopNotice, streamPartToWireEvent, usageBudgetNotice } from '../../chat/turn.js';
import {
  chatRuntimePayload,
  chatRuntimeResultMessageId,
  recordChatRuntimeProviderInput,
  settleChatRuntimeTrace,
  startChatRuntimeTrace,
  type ChatRuntimeTerminalStatus,
  type ChatRuntimeTrace,
} from '../../chat/runtime.js';
import { isChatModelAllowed } from '../../config/models.js';
import { resolveMemoryContext } from '../../llm/memory.js';
import { createProviderAttemptBudgetHook } from '../../llm/usage-budget.js';
import type { AgentProfile } from '../../profiles/profile.js';
import { instrumentRuntimeTools } from '../../runtime/tool-evidence.js';
import { runtimeAdapterEnabled } from '../../trusted-execution/kill-switches.js';
import { connectionManager } from '../../ws/connection-manager.js';
import { createBotRequest, requestApproval, requestLine } from './approvals.js';
import { compactObservationPipeline, createObservationTrimmer } from './context-trim.js';
import type { BotTurnContext } from './context.js';
import { copy, type BotsLocale } from './copy.js';
import { botsEngineDeps } from './deps.js';
import { CHAIN_LIMITS, STEP_CAPS, type FloorController, type FloorItem } from './floor.js';
import type { ConversationPort, TeamPort } from './ports.js';
import { projectHistory } from './projection.js';
import {
  assembleSystemPrompt,
  buildDigestSection,
  buildIdentity,
  buildInstruction,
  buildMemberNotes,
  buildStaticRules,
  buildTurnTail,
  renderNotesIndex,
  SKIP_TOKEN,
  toolFaceFlags,
  type RosterEntry,
} from './prompt.js';
import { observeToolResult } from './taint.js';
import { assembleInteractiveTools } from './tools-assembly.js';
import { readTail } from './transcript.js';
import { TranscriptChangedError, type TranscriptWriter } from './writer.js';

/** The projection window never exceeds this, whatever the model's own budget. */
export const PROJECTION_MAX_TOKENS = 48_000;
/** A follow-up may finish its few steps after the chain's wall clock ran out. */
const FOLLOWUP_GRACE_MS = 60_000;

export type LimitReason = Extract<BotEvent, { kind: 'limit' }>['reason'];

/** Per-run state shared by every turn of every chain in the run. */
export interface RunContext {
  run: ChatRun;
  db: DatabaseProvider;
  toolRegistry: ToolRegistry;
  user: { id: string; role: 'team' | 'super'; nickname: string; notes: string | null; locale: BotsLocale };
  sessionId: string;
  /** Live: re-read before every chain and turn (chain.ts refreshRoster). */
  conversation: ConversationWithMembers;
  /** Live member id set, updated in place (shared with every chain's floor controller). */
  members: Set<string>;
  /** Every Bot of the member, archived ones included (names in old messages); updated in place. */
  bots: Map<string, BotRow>;
  writer: TranscriptWriter;
  /** Digest snapshot for the whole run (spec: one snapshot per chain; never changes mid-run). */
  digest: { rendered: string | null; uptoSeq: number };
  effectiveTools: string[];
  profile: AgentProfile;
  /** Correlates Runtime traces of this run's turns. */
  triggerKey: string;
  turnCounter: number;
  usage: { input: number; output: number; cached: number; reasoning: number };
  startedAt: number;
}

/** Per-chain budgets. */
export interface ChainState {
  floor: FloorController;
  deadline: number;
  /** Provider input tokens with cached input weighted ×0.25. */
  inputWeighted: number;
  output: number;
  steps: number;
  limit: LimitReason | null;
  outcomes: Map<string, 'completed' | 'error' | 'skipped' | 'stopped'>;
}

export interface TurnResult {
  status: 'completed' | 'error' | 'stopped' | 'skipped';
  messageId?: string;
  /** A chain budget ran out during this turn. */
  limit?: LimitReason;
  /** The transcript changed under the writer: the chain must stop. */
  transcriptChanged?: boolean;
}

const USER_TRIGGERED: ReadonlySet<BotTurnReason> = new Set(['user', 'mention', 'interjection']);

interface StepUsage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  inputTokenDetails?: { cacheReadTokens?: number };
  outputTokenDetails?: { reasoningTokens?: number };
}

function readUsage(usage: StepUsage | undefined) {
  const input = Math.max(0, usage?.inputTokens ?? 0);
  const cached = Math.max(0, usage?.inputTokenDetails?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0);
  return {
    input,
    cached: Math.min(cached, input),
    output: Math.max(0, usage?.outputTokens ?? 0),
    reasoning: Math.max(0, usage?.outputTokenDetails?.reasoningTokens ?? usage?.reasoningTokens ?? 0),
  };
}

/** Marker on the synthetic abort that ends a handed-off turn (see `guardStopAfterStep`). */
const HANDOFF_STOP = Symbol('bots-handoff-stop');

/**
 * Whether a member message waits in the conversation's inbox (the chain
 * answers it right after an interrupt). Unreadable counts as none: the worst
 * case is a stop notice above a message that is then answered anyway.
 */
export async function memberMessageQueued(db: DatabaseProvider, sessionId: string): Promise<boolean> {
  try {
    return (await db.bots.listPendingInbox(sessionId)).some((row) => row.kind === 'user_message');
  } catch {
    return false;
  }
}

/**
 * A turn that ended because of a hand-off, a take-over request or the
 * member's soft stop is SUPPOSED to stop without a final answer. DeepSeek's
 * final-answer guarantee would otherwise splice one in — making the asker
 * answer for the Bot it just asked, or keeping the floor from a member who
 * asked for it. A trailing synthetic `abort` keeps the splice off; the
 * consumer drops it.
 */
function guardStopAfterStep<T extends object>(
  streamResult: T & { fullStream: AsyncIterable<unknown> },
  stopped: () => boolean,
): T {
  async function* guarded() {
    for await (const part of streamResult.fullStream) yield part;
    if (stopped()) yield { type: 'abort', [HANDOFF_STOP]: true };
  }
  const stream = guarded();
  return new Proxy(streamResult, {
    get(target, prop) {
      if (prop === 'fullStream') return stream;
      return Reflect.get(target, prop, target) as unknown;
    },
  });
}

function rosterOf(rc: RunContext): RosterEntry[] {
  return rc.conversation.members
    .map((member) => {
      const bot = rc.bots.get(member.bot_id);
      return bot && bot.status === 'active'
        ? { id: bot.id, name: bot.name, role: bot.role, memberRole: member.role }
        : null;
    })
    .filter((entry): entry is RosterEntry => entry !== null);
}

function resolveTurnModel(bot: BotRow): string | undefined {
  return bot.model_id && isChatModelAllowed(bot.model_id) ? bot.model_id : undefined;
}

/** Run one Bot's turn. Never throws for a Bot failure; only the writer's CAS failure stops the chain. */
export async function runBotTurn(rc: RunContext, chain: ChainState, item: FloorItem): Promise<TurnResult> {
  const { db, run, user, sessionId } = rc;
  const locale = user.locale;
  const bot = rc.bots.get(item.botId);
  if (!bot || bot.status !== 'active' || !rc.members.has(bot.id)) {
    // The member addressed a Bot that was archived meanwhile: say so instead of
    // ending the round in silence. (A removed Bot already has its "left" line.)
    if (bot && bot.status !== 'active' && item.owner && USER_TRIGGERED.has(item.reason)) {
      await rc.writer.appendEvent({
        text: copy.botArchived(locale, bot.name),
        event: { kind: 'unavailable', bot_id: bot.id, reason: 'archived' },
      });
    }
    return { status: 'skipped' };
  }

  const turnIndex = ++rc.turnCounter;
  const turnAbort = new AbortController();
  const onRunAbort = () => turnAbort.abort();
  if (run.signal.aborted) turnAbort.abort();
  else run.signal.addEventListener('abort', onRunAbort, { once: true });
  let limit: LimitReason | undefined;
  const wallMs = chain.deadline - Date.now() + (item.reason === 'followup' ? FOLLOWUP_GRACE_MS : 0);
  const wallTimer = setTimeout(
    () => {
      limit ??= 'wall_clock';
      turnAbort.abort();
    },
    Math.max(0, wallMs),
  );
  wallTimer.unref?.();

  let stopAfter: 'handoff' | 'takeover' | null = null;
  /** The loop stopped at a step boundary because the member asked to (soft stop). */
  let interrupted = false;
  let tainted = false;
  const handoffs: Array<{ toBotId: string; message: string }> = [];
  const emit = (event: Record<string, unknown> & { type: string }) => run.emit(event);

  const writeRequestLine = async (row: { id: string; kind: BotRequestKind; payload: string }) => {
    const payload = safeJsonParse(row.payload, {}) as Parameters<typeof requestLine>[3];
    await rc.writer.appendEvent({
      text: requestLine(locale, bot.name, row.kind, payload),
      event: { kind: 'request', request_id: row.id, request_kind: row.kind, bot_id: bot.id },
      botId: bot.id,
    });
  };

  const ctx: BotTurnContext = {
    db,
    userId: user.id,
    userRole: user.role,
    locale,
    sessionId,
    bot,
    reason: item.reason,
    userTriggered: USER_TRIGGERED.has(item.reason),
    background: false,
    turnId: `${run.runId}:${turnIndex}`,
    signal: turnAbort.signal,
    emit,
    createRequest: async (kind, payload, opts) => {
      const row = await createBotRequest({
        db,
        userId: user.id,
        sessionId,
        bot,
        locale,
        kind,
        payload,
        ...(opts?.expiresInMs ? { expiresInMs: opts.expiresInMs } : {}),
        emit,
      });
      await writeRequestLine(row);
      return row;
    },
    requestApproval: (payload, opts) =>
      requestApproval({
        db,
        userId: user.id,
        sessionId,
        bot,
        locale,
        payload,
        ...(opts?.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        signal: turnAbort.signal,
        background: false,
        emit,
        onCreated: writeRequestLine,
      }),
    markTainted: () => {
      tainted = true;
    },
    isTainted: () => tainted,
    stopAfterStep: (reason) => {
      stopAfter ??= reason;
    },
    handoffs,
  };

  const team: TeamPort = {
    kind: rc.conversation.kind,
    // A getter: the member may switch Bot-to-Bot chat off while this turn runs.
    get allowBotChat() {
      return rc.conversation.allow_bot_chat;
    },
    members: () => rosterOf(rc).map((entry) => ({ bot: rc.bots.get(entry.id)!, role: entry.memberRole })),
    others: () => [...rc.bots.values()].filter((other) => other.status === 'active' && !rc.members.has(other.id)),
    checkAsk: (toBotId) => chain.floor.checkAsk(toBotId),
    acceptAsk: async (toBotId, message) => {
      // Record on the floor first (synchronously): a second ask in the same
      // step must see this one when it checks the budget.
      chain.floor.acceptAsk(toBotId, message);
      handoffs.push({ toBotId, message });
      ctx.stopAfterStep('handoff');
      const target = rc.bots.get(toBotId);
      await rc.writer.appendEvent({
        text: copy.ask(locale, bot.name, target?.name ?? toBotId, message),
        event: { kind: 'ask', from: bot.id, to: toBotId },
        botId: bot.id,
      });
    },
    addMember: async (botId) => {
      try {
        const row = await db.bots.addMember(user.id, sessionId, botId, `bot:${bot.id}`);
        rc.conversation.members.push(row);
        rc.members.add(botId);
        const added = rc.bots.get(botId);
        await rc.writer.appendEvent({
          text: copy.joined(locale, added?.name ?? botId, bot.name),
          event: { kind: 'joined', bot_id: botId, by: 'bot', by_bot_id: bot.id },
          botId: bot.id,
        });
        connectionManager.sendToUser(user.id, { type: 'bots:conversation', sessionId });
        return { ok: true as const };
      } catch (error) {
        if (error instanceof BotsDomainError) return { ok: false as const, error: error.message };
        throw error;
      }
    },
  };

  let recallMaxSeq = rc.digest.uptoSeq;
  const conversationPort: ConversationPort = {
    nickname: user.nickname,
    botName: (id) => (id ? (rc.bots.get(id)?.name ?? null) : null),
    recallMaxSeq: () => recallMaxSeq,
  };

  emit({
    type: 'bot-turn-start',
    bot_id: bot.id,
    reason: item.reason,
    ...(item.askedBy ? { asked_by: item.askedBy } : {}),
  });

  let trace: ChatRuntimeTrace | null = null;
  const collectors = createCollectors();
  let held = '';
  let holding = item.reason === 'followup';
  let admissionNotice: string | undefined;
  let modelId = rc.profile.model.id ?? 'unknown';
  let engineResultForTrace: Awaited<ReturnType<typeof buildEngineResult>> | undefined;
  // An object, not a `let`: the trace settles in `finally` from whatever the
  // turn's exit path recorded last.
  const traceState: { status: ChatRuntimeTerminalStatus } = { status: 'interrupted' };

  try {
    // ── Tools, prompt, history ──
    const { tools, approvalGated } = assembleInteractiveTools({
      db,
      ctx,
      toolRegistry: rc.toolRegistry,
      effectiveTools: rc.effectiveTools,
      team,
      conversation: conversationPort,
      runtimeRunId: null,
    });
    const modelOverride = resolveTurnModel(bot);
    const effectiveModel = modelOverride ?? rc.profile.model.id;
    const systemPrompt = assembleSystemPrompt([
      buildStaticRules(toolFaceFlags(Object.keys(tools), approvalGated), locale),
      buildIdentity(bot, user.nickname),
      buildMemberNotes(user.nickname, user.notes),
      buildDigestSection(rc.digest.rendered),
    ]);

    const tail = await readTail(db, sessionId, rc.digest.uptoSeq);
    const projection = projectHistory(tail.rows, {
      selfBotId: bot.id,
      locale,
      nickname: user.nickname,
      botNames: new Map([...rc.bots.values()].map((b) => [b.id, b.name])),
      uptoSeq: rc.digest.uptoSeq,
      budgetTokens: Math.min(resolveHistoryBudget(effectiveModel), PROJECTION_MAX_TOKENS),
    });
    recallMaxSeq =
      projection.firstSeq !== null ? projection.firstSeq - 1 : Math.max(rc.digest.uptoSeq, rc.writer.tailSeq);

    const [memoryBlock, openNotes] = await Promise.all([
      resolveMemoryContext(user.id, user.role, { botId: bot.id }),
      db.bots.listNotes(sessionId, { status: 'open' }),
    ]);
    const outcomes = (item.askedBots ?? []).map((id) => ({
      name: rc.bots.get(id)?.name ?? id,
      outcome: chain.outcomes.get(id) ?? ('pending' as const),
    }));
    const tailText = buildTurnTail({
      locale,
      selfBotId: bot.id,
      kind: rc.conversation.kind,
      roster: rosterOf(rc),
      groupRules: rc.conversation.description,
      memoryBlock,
      notesIndex: renderNotesIndex(
        openNotes.map((note) => ({
          id: note.id,
          title: note.title,
          pinned: note.pinned,
          authorName: note.author_bot_id ? (rc.bots.get(note.author_bot_id)?.name ?? null) : null,
        })),
        locale,
      ),
      instruction: buildInstruction({
        reason: item.reason,
        nickname: user.nickname,
        ...(item.askedBy ? { askedByName: rc.bots.get(item.askedBy)?.name ?? 'Bot' } : {}),
        ...(item.message ? { message: item.message } : {}),
        askedOutcomes: outcomes,
      }),
    });
    const engineMessages: EngineMessage[] = projection.messages.map((m) => ({ role: m.role, content: m.content }));
    const last = engineMessages[engineMessages.length - 1];
    if (last && last.role === 'user' && typeof last.content === 'string') {
      last.content = `${last.content}\n\n${tailText}`;
    } else {
      engineMessages.push({ role: 'user', content: tailText });
    }

    const maxSteps =
      item.reason === 'followup'
        ? STEP_CAPS.followup
        : Math.max(1, Math.min(STEP_CAPS[item.reason], CHAIN_LIMITS.steps - chain.steps));

    // ── Durable trace per Bot turn (unique source per run + turn index) ──
    let executionTools: ToolRegistry = tools;
    if (runtimeAdapterEnabled('chat')) {
      trace = await startChatRuntimeTrace(db, {
        ownerUserId: user.id,
        sessionId,
        sourceId: `bots:${rc.triggerKey}:${turnIndex}`,
        input: {
          source_mode: 'bots',
          bot_id: bot.id,
          reason: item.reason,
          asked_by: item.askedBy ?? null,
          profile_id: rc.profile.id,
          effective_model: effectiveModel,
          provider_message_projection: engineMessages,
        },
      });
      await recordChatRuntimeProviderInput(db, trace, {
        model: effectiveModel,
        model_config: rc.profile.model,
        max_steps: maxSteps,
        tool_choice: rc.profile.tool_choice ?? 'auto',
        tool_ids: Object.keys(tools),
        system_prompt: systemPrompt,
        messages: engineMessages,
      });
      executionTools = instrumentRuntimeTools(tools, {
        db,
        runId: trace.runId,
        stepId: trace.stepId,
        actorUserId: trace.actorUserId,
        executionAuthority: { mode: 'chat_projection' },
        idempotencyPrefix: 'chat',
      });
    }

    const providerAttemptHook = createProviderAttemptBudgetHook({
      db,
      userId: user.id,
      caller: 'bots-turn',
      profileId: rc.profile.id,
      sessionId,
      runId: trace?.runId ?? run.runId,
      budgetPool: 'standard',
      metadata: { max_steps: maxSteps, bot_id: bot.id, reason: item.reason },
    });
    const stopWhenHandedOff: StopCondition<ToolSet> = () => stopAfter !== null;
    // Soft stop: read after each step's tool calls completed, so the step in
    // flight (and its results) is kept and only the next one never starts.
    const stopWhenInterrupted: StopCondition<ToolSet> = () => {
      if (run.interruptRequested) interrupted = true;
      return interrupted;
    };
    const stream = await botsEngineDeps().createStream({
      profile: rc.profile,
      messages: engineMessages,
      tools: executionTools,
      systemPrompt,
      sessionId,
      abortSignal: turnAbort.signal,
      providerAttemptHook,
      ...(modelOverride ? { modelOverride } : {}),
      maxStepsOverride: maxSteps,
      extraStopWhen: [stopWhenHandedOff, stopWhenInterrupted],
      prepareStepMessages: createObservationTrimmer(),
    });
    modelId = stream.modelId;

    const interruption = () => '';
    try {
      // An interrupted turn stops without a final answer on purpose: no
      // spliced-in extra model call either (the member wants the floor back).
      for await (const raw of withFinalAnswerGuarantee(
        guardStopAfterStep(stream.streamResult, () => stopAfter !== null || interrupted),
        { profile: rc.profile, systemPrompt, baseMessages: engineMessages, providerAttemptHook },
      )) {
        const part = raw as { type: string; [HANDOFF_STOP]?: boolean } & Record<string, unknown>;
        if (part[HANDOFF_STOP]) continue;
        processStreamPart(part, collectors);
        // Each step of a follow-up holds its text back again: a later step's
        // standalone `<<skip>>` must not flash by after an earlier step spoke.
        if (part.type === 'start-step' && item.reason === 'followup') {
          holding = true;
          held = '';
        }

        if (part.type === 'finish-step') {
          const usage = readUsage(part.usage as StepUsage);
          chain.steps += 1;
          chain.inputWeighted += usage.input - usage.cached + usage.cached * CHAIN_LIMITS.cachedInputWeight;
          chain.output += usage.output;
          rc.usage.input += usage.input;
          rc.usage.cached += usage.cached;
          rc.usage.output += usage.output;
          rc.usage.reasoning += usage.reasoning;
          if (item.reason !== 'followup' && !limit) {
            if (chain.inputWeighted > CHAIN_LIMITS.inputTokens || chain.output > CHAIN_LIMITS.outputTokens)
              limit = 'tokens';
            else if (chain.steps >= CHAIN_LIMITS.steps) limit = 'steps';
            if (limit) turnAbort.abort();
          }
        } else if (part.type === 'tool-result' && observeToolResult(ctx, String(part.toolName), part.input, tainted)) {
          // Also noted in the vault's foreign-read ledger (taint.ts): a search or
          // an email is outside content with no origin — a later fill must ask.
          tainted = true;
        } else if (part.type === 'error') {
          admissionNotice ||= usageBudgetNotice(part.error, locale) ?? undefined;
        }
        // The chain owns the single `finish`; a Bot's failure is its bot-turn-end.
        if (part.type === 'finish' || part.type === 'error' || part.type === 'abort') continue;
        const event = streamPartToWireEvent(part, interruption);
        if (!event) continue;
        if (holding && event.type === 'text-delta') {
          held += String(event.text ?? '');
          if (SKIP_TOKEN.startsWith(held.trim())) continue;
          holding = false;
          emit({ type: 'text-delta', text: held });
          continue;
        }
        run.emit(event);
      }
    } catch (error) {
      collectors.streamError ||= toErrorMessage(error);
      admissionNotice ||= usageBudgetNotice(error, locale) ?? undefined;
    }

    const engineResult = await buildEngineResult(
      stream.streamResult,
      collectors,
      stream.dsmlRecoveries,
      stream.startTime,
    );
    engineResult.pipelineSteps = compactObservationPipeline(engineResult.pipelineSteps);
    engineResultForTrace = engineResult;
    const stoppedByMember = run.stopReason !== undefined;
    const completed =
      !turnAbort.signal.aborted &&
      !collectors.streamError &&
      engineResult.finishReason !== undefined &&
      engineResult.finishReason !== 'error';
    // A hand-off/take-over ends the loop through stopWhen — a normal finish.
    let text = engineResult.text.trim();
    const onlyHandoffs = handoffs.length > 0 && engineResult.pipelineSteps.every((step) => step.tool === 'team');

    // ── Follow-up with nothing to add ──
    // "Nothing to add" is an empty answer, exactly the token, or held text that
    // never got past the token's prefix (cut off mid-token). A token trailing
    // real text is stripped. Either way the raw token is never shown or stored.
    const followup = item.reason === 'followup';
    const saidSkip = followup && (!text || text === SKIP_TOKEN || (holding && SKIP_TOKEN.startsWith(text)));
    if (saidSkip) text = '';
    else if (followup && text.endsWith(SKIP_TOKEN)) text = text.slice(0, -SKIP_TOKEN.length).trimEnd();
    if (followup) engineResult.text = text;
    if (saidSkip && engineResult.pipelineSteps.length === 0 && (completed || stoppedByMember || limit)) {
      traceState.status = completed ? 'succeeded' : 'interrupted';
      emit({ type: 'bot-turn-end', bot_id: bot.id, status: 'skipped' });
      return { status: 'skipped', ...(limit ? { limit } : {}) };
    }
    // A follow-up that checked something with a tool and then said `<<skip>>`
    // keeps its steps (persisted under the "done, see the steps" placeholder).
    if (holding && held && !saidSkip) emit({ type: 'text-delta', text: held });

    // Text always persists. A tool-only turn persists a short placeholder so its
    // steps stay visible — except a pure hand-off, whose line is already there.
    const shouldPersist = Boolean(text) || (completed && engineResult.pipelineSteps.length > 0 && !onlyHandoffs);
    let status: TurnResult['status'];
    let notice: string | undefined;
    // Soft-stopped with nobody waiting: the run ends with this turn, which says
    // so like a Stop does. A queued member message is answered next instead.
    const stopNotice = interrupted && completed && !(await memberMessageQueued(db, sessionId));
    if (completed) {
      status = 'completed';
      if (stopNotice) notice = chatStopNotice(locale);
    } else if (stoppedByMember || limit) {
      status = 'stopped';
      notice = stoppedByMember ? chatStopNotice(locale) : copy.limitInterruption(locale);
    } else {
      status = 'error';
      notice = admissionNotice ?? chatInterruptionNotice(locale);
    }

    let messageId: string | undefined;
    if (shouldPersist) {
      await rc.writer.settled();
      const outcome = await persistChatResult({
        sessionId,
        caller: 'bots',
        modelId,
        engineResult,
        dsmlRecoveries: stream.dsmlRecoveries,
        streamCompleted: completed,
        ...(notice ? { interruptionReason: collectors.streamError ?? 'interrupted' } : {}),
        interruptionNotice: notice ?? chatInterruptionNotice(locale),
        expectedTail: rc.writer.tail ?? undefined,
        botId: bot.id,
        // A soft-stopped turn that keeps the stop notice needs no placeholder: the notice is its line.
        ...(stopNotice && handoffs.length === 0 && stopAfter === null
          ? {}
          : {
              emptyTextFallback:
                handoffs.length > 0
                  ? copy.handedOver(
                      locale,
                      handoffs.map((h) => rc.bots.get(h.toBotId)?.name ?? h.toBotId),
                    )
                  : stopAfter === 'takeover'
                    ? copy.waitingForMember(locale)
                    : interrupted
                      ? copy.interruptedWithoutText(locale)
                      : copy.workedWithoutText(locale),
            }),
        ...(trace
          ? { resultMessageId: chatRuntimeResultMessageId(trace.runId, completed ? 'succeeded' : 'interrupted') }
          : {}),
      });
      if (outcome.status === 'skipped') throw new TranscriptChangedError(sessionId);
      if (outcome.status === 'appended' || outcome.status === 'replaced') {
        rc.writer.advance(outcome.message);
        messageId = outcome.message.id;
      }
    } else if (status === 'error') {
      await rc.writer.appendEvent({
        text: copy.turnError(locale, bot.name, notice ?? chatInterruptionNotice(locale)),
        event: { kind: 'turn_error', bot_id: bot.id, error: notice ?? '' },
        botId: bot.id,
      });
    }
    traceState.status = stoppedByMember
      ? run.stopReason === 'user'
        ? 'canceled'
        : 'interrupted'
      : completed
        ? 'succeeded'
        : 'interrupted';

    await db.bots.touchBot(bot.id).catch(() => undefined);
    emit({
      type: 'bot-turn-end',
      bot_id: bot.id,
      status,
      ...(messageId ? { message_id: messageId } : {}),
      ...(status === 'error' && notice ? { error: notice } : {}),
    });
    return { status, ...(messageId ? { messageId } : {}), ...(limit ? { limit } : {}) };
  } catch (error) {
    if (error instanceof TranscriptChangedError) {
      logger.warn('[bots] transcript changed under the writer — stopping the chain', { sessionId, botId: bot.id });
      emit({ type: 'bot-turn-end', bot_id: bot.id, status: 'error', error: chatInterruptionNotice(locale) });
      traceState.status = 'failed';
      return { status: 'error', transcriptChanged: true };
    }
    logger.error('[bots] turn failed', { sessionId, botId: bot.id, error: toErrorMessage(error) });
    const notice = usageBudgetNotice(error, locale) ?? chatInterruptionNotice(locale);
    traceState.status = 'failed';
    try {
      await rc.writer.appendEvent({
        text: copy.turnError(locale, bot.name, notice),
        event: { kind: 'turn_error', bot_id: bot.id, error: notice },
        botId: bot.id,
      });
    } catch (writeError) {
      if (writeError instanceof TranscriptChangedError) {
        emit({ type: 'bot-turn-end', bot_id: bot.id, status: 'error', error: notice });
        return { status: 'error', transcriptChanged: true };
      }
    }
    emit({ type: 'bot-turn-end', bot_id: bot.id, status: 'error', error: notice });
    return { status: 'error', ...(limit ? { limit } : {}) };
  } finally {
    clearTimeout(wallTimer);
    run.signal.removeEventListener('abort', onRunAbort);
    if (trace) {
      const usage = engineResultForTrace?.usage;
      await settleChatRuntimeTrace(db, trace, {
        status: traceState.status,
        output: chatRuntimePayload({
          model_id: modelId,
          bot_id: bot.id,
          engine_result: engineResultForTrace ?? null,
          stream: { received_finish: collectors.receivedFinish, error: collectors.streamError ?? null },
        }),
        ...(traceState.status === 'canceled' ? { errorCode: 'chat_user_canceled' } : {}),
        ...(traceState.status === 'interrupted' ? { errorCode: 'chat_stream_interrupted' } : {}),
        ...(traceState.status === 'failed' ? { errorCode: 'chat_turn_failed' } : {}),
        ...(usage ? { tokensUsed: Math.max(0, usage.inputTokens) + Math.max(0, usage.outputTokens) } : {}),
        ...(engineResultForTrace ? { durationMs: engineResultForTrace.durationMs } : {}),
      }).catch((error) => logger.error('[bots] runtime trace settlement failed', { error: toErrorMessage(error) }));
    }
  }
}
