/**
 * The tools of one turn: the definitions that exist for this member, Agent and surface, wrapped
 * so every call is a recorded step and the turn knows when it read outside text.
 */

import { tool, type ToolSet } from 'ai';
import { and, eq, sql } from 'drizzle-orm';
import { getDb, newId, runSteps, type NeedsYouRequest } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { surfacesOf, type AvailabilityContext, type Card, type ToolContext, type ToolDef } from './define.js';

const MAX_STORED_JSON = 20_000;

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
  defs: Map<string, ToolDef>;
  /** True once a tool raised a card: the turn ends after this step. */
  waiting(): boolean;
  markWaiting(): void;
}

const MAX_DETAIL_FIELDS = 12;
const MAX_DETAIL_CHARS = 300;

/** What an approval card shows when the tool does not describe itself: its arguments. */
export function argumentDetails(args: unknown): { label: string; value: string }[] {
  if (!args || typeof args !== 'object') return [];
  const entries = Object.entries(args as Record<string, unknown>).filter(([, value]) => value !== undefined);
  const rows = entries.slice(0, MAX_DETAIL_FIELDS).map(([label, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return {
      label,
      value:
        text.length > MAX_DETAIL_CHARS
          ? `${text.slice(0, MAX_DETAIL_CHARS)}…(+${text.length - MAX_DETAIL_CHARS} more characters)`
          : text,
    };
  });
  if (entries.length > MAX_DETAIL_FIELDS)
    rows.push({ label: '…', value: `+${entries.length - MAX_DETAIL_FIELDS} more fields` });
  return rows;
}

export async function assembleTools(input: {
  defs: readonly ToolDef[];
  context: Omit<ToolContext, 'stepId' | 'raise'>;
  availability: AvailabilityContext;
  /** Records a card for the member, tied to this run and step. */
  raise: (card: Card, stepId: string) => Promise<NeedsYouRequest>;
  /** The card heading for an approval, in the member's language. */
  approvalTitle: (summary: string) => string;
}): Promise<TurnTools> {
  const { context, availability } = input;
  const allowed = context.manifest.tools ? new Set(context.manifest.tools) : null;
  const chosen: ToolDef[] = [];
  for (const def of input.defs) {
    if (!surfacesOf(def).includes(context.surface)) continue;
    if (allowed && !allowed.has(def.name)) continue;
    if (def.risk !== 'read' && !context.manifest.write) continue;
    if (def.available && !(await def.available(availability))) continue;
    chosen.push(def);
  }

  let waiting = false;
  const tools: ToolSet = {};
  for (const def of chosen) {
    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.input,
      execute: async (args: unknown, options: { toolCallId: string; abortSignal?: AbortSignal }) => {
        const started = Date.now();
        const stepId = newId('runStep');
        await getDb()
          .insert(runSteps)
          .values({
            id: stepId,
            runId: context.runId,
            key: options.toolCallId,
            kind: 'tool',
            toolName: def.name,
            risk: def.risk,
            status: 'running',
            input: (bounded(args) ?? {}) as Record<string, unknown>,
            startedAt: new Date(started).toISOString(),
          })
          .onConflictDoNothing();
        if (def.taints) context.taint();
        const call: ToolContext = {
          ...context,
          stepId,
          signal: options.abortSignal ?? context.signal,
          raise: async (card) => {
            const request = await input.raise({ ...card, payload: { tool: def.name, ...card.payload } }, stepId);
            if (card.waits) waiting = true;
            return request;
          },
        };
        if (def.risk !== 'read' && (def.needsApproval ? def.needsApproval(args, call) : true)) {
          // Nothing changes until the member approves; the engine runs exactly these arguments then.
          const card = def.describe?.(args, call) ?? { summary: def.name, details: argumentDetails(args) };
          const request = await call.raise({
            kind: 'approval',
            subject: 'tool_write',
            title: input.approvalTitle(card.summary),
            payload: { tool: def.name, input: args, summary: card.summary, details: card.details },
            waits: true,
          });
          await getDb()
            .update(runSteps)
            .set({ status: 'pending', requestId: request.id, updatedAt: sql`now()` })
            .where(eq(runSteps.id, stepId));
          return {
            status: 'needs_approval',
            request_id: request.id,
            note: 'The member sees an approval card. End your turn now; you will be told the outcome.',
          };
        }
        const finish = async (status: 'succeeded' | 'failed', output: unknown, error?: string) => {
          await getDb()
            .update(runSteps)
            .set({
              status,
              output: bounded(output),
              error: error ? { code: 'tool_failed', message: error.slice(0, 1000) } : null,
              durationMs: Date.now() - started,
              finishedAt: sql`now()`,
              updatedAt: sql`now()`,
            })
            .where(and(eq(runSteps.id, stepId)));
        };
        try {
          const output = await def.execute(args, call);
          await finish('succeeded', output);
          return output;
        } catch (error) {
          await finish('failed', undefined, toErrorMessage(error));
          throw error;
        }
      },
    } as never);
  }
  return {
    tools,
    names: new Set(chosen.map((def) => def.name)),
    defs: new Map(chosen.map((def) => [def.name, def])),
    waiting: () => waiting,
    markWaiting: () => {
      waiting = true;
    },
  };
}
