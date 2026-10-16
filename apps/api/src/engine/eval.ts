/** Portable harness evidence; credentials and signed links are removed before export. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { and, asc, desc, eq, sql } from 'drizzle-orm';
import { getDb, messages, runs, runSteps } from '@greenhouse/db';
import type { AgentManifest, MemberModules } from '@greenhouse/contract';
import type { EngineMessage } from '@greenhouse/agent-core';
import { ApiError } from '../http/errors.js';
import {
  assembleTurnPrompt,
  assembleBackgroundPrompt,
  type BackgroundPromptRecipe,
  type TurnPromptRecipe,
} from './prompt.js';
import type { AvailabilityContext, Surface, ToolDef } from './tools/define.js';
import { toolInputSchema } from './tools/schema.js';

const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, ordered(item)]),
        )
      : value;
export const digest = (value: unknown) =>
  createHash('sha256')
    .update(JSON.stringify(ordered(value)))
    .digest('hex');
export async function toolDefinition(def: ToolDef) {
  return {
    name: def.name,
    description: def.description,
    schema: await toolInputSchema(def.input).jsonSchema,
    risk: def.risk,
    idempotent: def.idempotent === true,
  };
}
export interface Harness {
  runKind?: 'turn' | 'background';
  recipe?: TurnPromptRecipe;
  background?: BackgroundPromptRecipe;
  transcript: EngineMessage[];
  definitions: Awaited<ReturnType<typeof toolDefinition>>[];
  manifest: AgentManifest;
  modules: MemberModules;
  mainAgent: boolean;
  readOnly?: boolean;
  tainted?: boolean;
  surface: Surface;
  publicAgent: AvailabilityContext['publicAgent'];
  capabilities: unknown[][];
}
export async function recordHarness(runId: string, input: Omit<Harness, 'definitions'> & { definitions: ToolDef[] }) {
  const harness: Harness = {
    ...input,
    transcript: input.transcript.map((message) => ({
      ...message,
      content: Array.isArray(message.content)
        ? message.content.map((part) =>
            part.type === 'image' ? { type: 'text' as const, text: '[media omitted from Eval snapshot]' } : part,
          )
        : message.content,
    })),
    definitions: await Promise.all(input.definitions.map(toolDefinition)),
  };
  await getDb()
    .update(runs)
    .set({ checkpoint: sql`coalesce(${runs.checkpoint}, '{}'::jsonb) || ${JSON.stringify({ eval: harness })}::jsonb` })
    .where(eq(runs.id, runId));
}

export function redactFixture(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactFixture);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /^(password|secret|api_?key|access_token|refresh_token|authorization|cookie)$/i.test(key)
          ? '[redacted]'
          : redactFixture(item),
      ]),
    );
  if (typeof value !== 'string') return value;
  return value
    .replace(/\b(?:sk-|re_)[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/([?&](?:sig|token|key)=)[^&\s"<>]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g, '[redacted]');
}
export async function exportFixture(id: string, folder = resolve('fixtures/eval')) {
  let runId = id;
  if (id.startsWith('msg_')) {
    const [message] = await getDb().select({ runId: messages.runId }).from(messages).where(eq(messages.id, id));
    if (!message) throw new ApiError(404, 'not_found', 'Message not found.');
    if (message.runId) runId = message.runId;
    else {
      const candidates = await getDb()
        .select({ id: runs.id })
        .from(runs)
        .where(
          and(
            eq(runs.kind, 'turn'),
            sql`${runs.input}->'message_ids' @> ${JSON.stringify([id])}::jsonb`,
            sql`${runs.checkpoint}->'eval' IS NOT NULL`,
          ),
        )
        .orderBy(desc(runs.createdAt), desc(runs.id))
        .limit(2);
      if (!candidates.length)
        throw new ApiError(404, 'eval_unavailable', 'No prompt evidence remains for this message.');
      if (candidates.length > 1)
        throw new ApiError(
          409,
          'eval_ambiguous',
          'More than one Agent answered this message. Export a reply or run id.',
        );
      runId = candidates[0]!.id;
    }
  }
  const [run] = await getDb().select().from(runs).where(eq(runs.id, runId));
  const harness = run?.checkpoint?.eval as Harness | undefined;
  if (!run || !harness) throw new ApiError(404, 'eval_unavailable', 'No prompt evidence remains for this run.');
  const steps = await getDb()
    .select()
    .from(runSteps)
    .where(eq(runSteps.runId, runId))
    .orderBy(asc(runSteps.createdAt), asc(runSteps.id));
  const safe = redactFixture({
    version: 1,
    source: { run_id: runId, model: run.input.model_ref ?? null, status: run.status },
    harness,
    steps: steps.map((step) => ({
      kind: step.kind,
      tool: step.toolName,
      status: step.status,
      risk: step.risk,
      input: step.input,
      output: step.output,
      error: step.error,
    })),
  }) as { harness: Harness };
  const assembled = assembleHarness(safe.harness);
  const fixture = {
    ...safe,
    expected: {
      system: digest(assembled.system),
      tail: digest(assembled.tail),
      tools: safe.harness.definitions.map((def) => ({ name: def.name, hash: digest(def) })),
    },
  };
  await mkdir(folder, { recursive: true });
  const path = resolve(folder, `${runId}.json`);
  await writeFile(path, JSON.stringify(fixture, null, 2) + '\n', { mode: 0o600 });
  return path;
}

export function assembleHarness(harness: Harness) {
  if (harness.recipe) return assembleTurnPrompt(harness.recipe);
  if (harness.background) return assembleBackgroundPrompt(harness.background);
  throw new Error('Eval prompt recipe is missing.');
}
