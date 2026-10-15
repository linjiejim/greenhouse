import { tableEventChain } from '../../modules/tables/event-context.js';
/**
 * The tools of one turn: the definitions that exist for this member, Agent and surface, wrapped
 * so every call is a recorded step and the turn knows when it read outside text.
 */

import { createHash } from 'node:crypto';
import { tool, type ToolSet } from 'ai';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  getDb,
  conversations,
  members,
  newId,
  runSteps,
  runs,
  transaction,
  type NeedsYouRequest,
} from '@greenhouse/db';
import type { ApprovalsService } from '../../modules/agents/approvals.js';
import { surfacesOf, type AvailabilityContext, type Card, type ToolContext, type ToolDef } from './define.js';
import { ApiError } from '../../http/errors.js';
import { argumentDetails, failureSummary } from './presentation.js';
import { toolInputSchema } from './schema.js';
import { createKeyedLock } from '../locks.js';

const MAX_STORED_JSON = 20_000;

/** What the model reads instead of a result when an earlier attempt left the same call unfinished. */
const UNCERTAIN_RESULT = {
  status: 'uncertain',
  note: 'An earlier attempt of this run made this exact call and stopped before it finished, so whether it took effect is unknown. Check the current state first, and make the call again only if it did not happen.',
};

/**
 * Steps a run's dead process left running. A pure read simply failed; any other call may have
 * had its effect outside, so its outcome is unknown (`uncertain`) and nothing makes it again by
 * itself.
 */
export async function abandonSteps(runId: string, defs: readonly ToolDef[]): Promise<void> {
  const reads = defs.filter((def) => def.idempotent).map((def) => def.name);
  const running = and(eq(runSteps.runId, runId), eq(runSteps.kind, 'tool'), eq(runSteps.status, 'running'));
  if (reads.length) {
    await getDb()
      .update(runSteps)
      .set({
        status: 'failed',
        error: { code: 'interrupted', message: 'The process running it stopped.' },
        finishedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(and(running, inArray(runSteps.toolName, reads)));
  }
  await getDb()
    .update(runSteps)
    .set({ status: 'uncertain', finishedAt: sql`now()`, updatedAt: sql`now()` })
    .where(running);
}

/** Step rows keep a bounded copy of inputs and outputs. */
function bounded(value: unknown): unknown {
  if (value === undefined) return null;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return { unserializable: true };
  }
  if (text.length <= MAX_STORED_JSON) return value;
  return { truncated: true, preview: text.slice(0, MAX_STORED_JSON) };
}

export interface TurnTools {
  tools: ToolSet;
  /** Names of the tools present, for the rules paragraphs. */
  names: Set<string>;
  /** What the tools add to the closing message (turnContext), in tool order. */
  context: string[];
  defs: Map<string, ToolDef>;
  /** True once a tool raised a card: the turn ends after this step and its run waits. */
  waiting(): boolean;
  markWaiting(): void;
  /** True once a tool ended the turn (a hand-off). */
  ended(): boolean;
}

/** JSON with sorted keys: the same arguments always give the same text. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The key of one call within a run: the same tool with the same arguments is the same step. */
export function callKey(tool: string, args: unknown): string {
  return createHash('sha256')
    .update(`${tool}\n${stable(args)}`)
    .digest('hex');
}

export async function assembleTools(input: {
  defs: readonly ToolDef[];
  context: Omit<ToolContext, 'stepId' | 'raise' | 'endTurn'>;
  availability: AvailabilityContext;
  /** Records a card for the member, tied to this run and step. */
  raise: (card: Card, stepId: string) => Promise<NeedsYouRequest>;
  /** The card heading for an approval, in the member's language. */
  approvalTitle: (summary: string) => string;
  approvals?: ApprovalsService;
  output?: (value: unknown, ctx: ToolContext) => Promise<unknown>;
  receipt?: (stepId: string, summary: string) => Promise<void>;
  privateRead?: () => Promise<void>;
}): Promise<TurnTools> {
  const { context, availability } = input;
  const allowed = context.manifest.tools ? new Set(context.manifest.tools) : null;
  // Which tools and in what order depends on the Agent version and the member's access, never on
  // anything that changes between turns: the definitions stay byte for byte the same.
  const chosen: ToolDef[] = [];
  const turnContext: string[] = [];
  for (const def of input.defs) {
    if (!surfacesOf(def).includes(context.surface)) continue;
    // Someone else's public Agent gets only the tools that act on the asker's own things.
    if (availability.publicAgent && !def.publicAgent) continue;
    if (allowed && !allowed.has(def.name)) continue;
    if (def.risk !== 'read' && !context.manifest.write) continue;
    if (context.readOnly && !def.idempotent && !['memory', 'conversation_query', 'mcp_call'].includes(def.name))
      continue;
    if (def.available && !(await def.available(availability))) continue;
    chosen.push(context.surface === 'background' && def.backgroundInput ? { ...def, input: def.backgroundInput } : def);
    const section = def.turnContext ? await def.turnContext(availability) : null;
    if (section) turnContext.push(section);
  }

  let waiting = false;
  let ended = false;
  // Some servers reuse call ids across steps ("call_0"); a step key must still be unique.
  const usedKeys = new Map<string, number>();
  const stepKey = (callId: string) => {
    const seen = usedKeys.get(callId) ?? 0;
    usedKeys.set(callId, seen + 1);
    return seen ? `${callId}#${seen + 1}` : callId;
  };
  // Nobody watches a background run: once it has read private data it may not reach outside.
  const [savedRun] = await getDb()
    .select({ checkpoint: runs.checkpoint, input: runs.input })
    .from(runs)
    .where(eq(runs.id, context.runId));
  let readPrivate = savedRun?.checkpoint?.read_private === true;
  if (savedRun?.checkpoint?.tainted === true) context.taint();
  const tools: ToolSet = {};
  const serialize = createKeyedLock();
  for (const def of chosen) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: toolInputSchema(def.input),
      execute: (args: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) =>
        serialize(context.runId, async () => {
          if (context.signal.aborted || options.abortSignal?.aborted) throw new Error('Stopped.');
          const [member] = await getDb()
            .select({ status: members.status })
            .from(members)
            .where(eq(members.id, context.memberId));
          if (member?.status !== 'active') throw new Error('The member is no longer active.');
          if (def.outbound && def.name !== 'computer' && readPrivate && context.surface === 'background') {
            throw new Error(
              'This run has read private data, so it can no longer search or open web pages. Report what you have.',
            );
          }
          if (def.privateRead ? await def.privateRead(args, context) : def.private) {
            readPrivate = true;
            await input.privateRead?.();
          }
          const started = Date.now();
          const key = stepKey(options.toolCallId);
          const attempt = context.attempt ?? 1;
          let risk = def.callRisk
            ? await def.callRisk(args, context)
            : def.risk === 'read'
              ? 'read'
              : def.risk === 'external'
                ? 'tier3'
                : 'tier2';
          if (context.readOnly && risk !== 'read') throw new Error('Helper runs are read-only.');
          if (risk !== 'read' && !context.manifest.write) throw new Error('Writing is disabled for this Agent.');
          // A background run can be retried: the same call (tool and arguments) is the same step.
          const idempotencyKey = context.surface === 'background' ? callKey(def.name, args) : null;
          if (idempotencyKey) {
            const [earlier] = await getDb()
              .select({ id: runSteps.id, status: runSteps.status, attempt: runSteps.attempt, output: runSteps.output })
              .from(runSteps)
              .where(and(eq(runSteps.runId, context.runId), eq(runSteps.idempotencyKey, idempotencyKey)));
            // A call that already succeeded returns what it returned.
            if (earlier?.status === 'succeeded' || earlier?.status === 'skipped')
              return earlier.output ?? { status: 'declined', note: 'The member declined this call. Do not repeat it.' };
            if (earlier?.status === 'pending') {
              waiting = true;
              return { status: 'needs_approval', note: 'This call still waits for the member.' };
            }
            // An earlier attempt died while making this call: with effects outside, it is not made
            // again blindly. The Agent is told once per attempt; calling it again after that runs it.
            if (
              earlier &&
              !def.idempotent &&
              (earlier.status === 'running' || earlier.status === 'uncertain') &&
              earlier.attempt < attempt
            ) {
              await getDb()
                .update(runSteps)
                .set({ key, attempt, status: 'uncertain', finishedAt: sql`now()`, updatedAt: sql`now()` })
                .where(eq(runSteps.id, earlier.id));
              return UNCERTAIN_RESULT;
            }
          }
          const [row] = await getDb()
            .insert(runSteps)
            .values({
              id: newId('runStep'),
              runId: context.runId,
              key,
              attempt,
              kind: 'tool',
              toolName: def.name,
              risk,
              idempotencyKey,
              status: 'running',
              input: (bounded(args) ?? {}) as Record<string, unknown>,
              startedAt: new Date(started).toISOString(),
            })
            .onConflictDoUpdate({
              target: [runSteps.runId, runSteps.idempotencyKey],
              set: {
                key,
                attempt,
                status: 'running',
                output: null,
                error: null,
                startedAt: new Date(started).toISOString(),
                finishedAt: null,
                updatedAt: sql`now()`,
              },
            })
            .returning({ id: runSteps.id });
          const stepId = row!.id;
          if (def.taints) context.taint();
          await getDb()
            .update(runs)
            .set({
              checkpoint: sql`coalesce(${runs.checkpoint}, '{}'::jsonb) || ${JSON.stringify({ read_private: readPrivate, tainted: context.tainted() })}::jsonb`,
            })
            .where(eq(runs.id, context.runId));
          const call: ToolContext = {
            ...context,
            stepId,
            signal: options.abortSignal ?? context.signal,
            waitForRuns: () => {
              waiting = true;
            },
            endTurn: () => {
              ended = true;
            },
            raise: async (card) => {
              const request = await input.raise({ ...card, payload: { tool: def.name, ...card.payload } }, stepId);
              if (card.waits) waiting = true;
              return request;
            },
          };
          const finish = async (
            status: 'succeeded' | 'failed',
            output: unknown,
            error?: { code: string; message: string },
          ) => {
            await getDb()
              .update(runSteps)
              .set({
                status,
                output: bounded(output),
                error: error ? { code: error.code, message: error.message.slice(0, 1000) } : null,
                durationMs: Date.now() - started,
                finishedAt: sql`now()`,
                updatedAt: sql`now()`,
              })
              .where(and(eq(runSteps.id, stepId)));
          };
          const perform = async () => {
            if (call.signal.aborted) throw new Error('Stopped.');
            if (def.undo && context.conversation)
              await getDb()
                .select({ id: conversations.id })
                .from(conversations)
                .where(eq(conversations.id, context.conversation.id))
                .for('update');
            await def.guard?.(args, call);
            if (risk !== 'read' && def.callRisk) {
              risk = await def.callRisk(args, context);
              await getDb().update(runSteps).set({ risk }).where(eq(runSteps.id, stepId));
            }
            const scope = risk === 'tier2' ? ((await def.approvalScope?.(args, call)) ?? null) : null;
            const standing =
              scope && !context.tainted() && (await input.approvals?.allows(context.agent.id, context.memberId, scope));
            if (risk === 'tier3' || (risk === 'tier2' && !standing)) {
              // Nothing changes until the member approves; the engine runs exactly these arguments then.
              const card = (await def.describe?.(args, call)) ?? {
                summary: context.locale === 'zh' ? '执行操作' : 'Perform action',
                details: argumentDetails(args, context.locale),
              };
              const request = await call.raise({
                kind: 'approval',
                subject: 'tool_write',
                title: input.approvalTitle(card.summary),
                payload: {
                  tool: def.name,
                  input: args,
                  summary: card.summary,
                  details: card.details,
                  tier: risk,
                  ...(scope ? { standing_scope: scope } : {}),
                },
                waits: true,
              });
              await getDb()
                .update(runSteps)
                .set({ status: 'pending', requestId: request.id, updatedAt: sql`now()` })
                .where(eq(runSteps.id, stepId));
              return {
                status: 'needs_approval',
                request_id: request.id,
                step_id: stepId,
                summary: String(
                  (request.payload.calls as Array<{ step_id: string; summary: string }> | undefined)?.find(
                    (call) => call.step_id === stepId,
                  )?.summary ??
                    request.payload.summary ??
                    card.summary,
                ),
                note: 'The member sees an approval card. End your turn now; you will be told the outcome.',
              };
            }
            let reversible = false;
            if (def.before && risk !== 'read') {
              const before = await def.before(args, call);
              reversible = before != null;
              await getDb().update(runSteps).set({ undoState: before }).where(eq(runSteps.id, stepId));
            }
            const output = await def.execute(args, call);
            if (def.undo && reversible) {
              const [saved] = await getDb()
                .select({ before: runSteps.undoState })
                .from(runSteps)
                .where(eq(runSteps.id, stepId));
              await getDb()
                .update(runSteps)
                .set({ undoState: { before: saved?.before, output: def.undoResult?.(output) ?? output } })
                .where(eq(runSteps.id, stepId));
            }
            const evidence =
              input.output && def.name !== 'tool_output_read'
                ? await input.output(output, { ...call, outputPrivate: readPrivate })
                : output;
            await finish('succeeded', evidence);
            if ((risk === 'tier1' || standing) && reversible && def.undo && input.receipt) {
              const summary =
                (await def.receipt?.(args, output, call)) ??
                def.summarize?.(args, output, context.locale) ??
                (context.locale === 'zh' ? '完成了操作' : 'Completed an action');
              await input.receipt(stepId, summary);
            }
            return evidence;
          };
          try {
            return risk === 'read'
              ? await perform()
              : await tableEventChain.run((savedRun?.input.event_chain as string[] | undefined) ?? [], () =>
                  transaction(perform),
                );
          } catch (error) {
            const summary = failureSummary(def, args, error, call);
            await finish('failed', undefined, {
              code: error instanceof ApiError ? error.code : 'tool_failed',
              message: summary,
            });
            throw new ApiError(
              error instanceof ApiError ? error.status : 502,
              error instanceof ApiError ? error.code : 'tool_failed',
              summary,
            );
          }
        }),
    } as never);
  }
  return {
    tools,
    names: new Set(chosen.map((def) => def.name)),
    context: turnContext,
    defs: new Map(chosen.map((def) => [def.name, def])),
    waiting: () => waiting,
    markWaiting: () => {
      waiting = true;
    },
    ended: () => ended,
  };
}
