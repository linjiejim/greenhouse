/**
 * User Memory — recall index, write-side validation, and the weekly
 * consolidation pass.
 *
 * - buildMemoryIndexBlock(): the block injected into a system prompt. Titles
 *   only, within a hard budget — bodies are pulled on demand by the `memory`
 *   tool. Injection is NOT a use: it never touches last_used_at.
 * - validateMemoryText(): shared write-side guard for the tool and the REST API.
 * - runMemoryConsolidation(): weekly upkeep — merge duplicates, supersede
 *   contradictions, demote stale rows. It never invents new memories.
 *
 * v1's daily extraction cron was deleted; see docs/specs/20260804-memory-v2.md.
 */

import { generateText } from 'ai';
import { toErrorMessage } from '@greenhouse/utils/error';
import {
  createModelFromConfig,
  resolveModelConfig,
  buildProviderOptions,
  type ModelConfig,
} from '@greenhouse/agent-core';
import { logger } from '@greenhouse/utils/logger';
import { extractJson } from '@greenhouse/utils/json';
import { getDb, type UserMemoryRow } from '@greenhouse/db';
import { sanitizeForPrompt } from '../security.js';
import { MEMORY_INDEX_BUDGET_CHARS, validateMemoryText } from './memory-limits.js';
import { userHasFeature } from '../auth/features.js';
import type { UserRole } from '../auth/token.js';
import { createProviderAttemptBudgetHook } from './usage-budget.js';

// ─── Limits & write-side validation ─────────────────────

// Limits/validation live in a zero-import leaf module so tool descriptions can
// interpolate them at module-eval time without risking an import cycle.
export {
  MEMORY_INDEX_BUDGET_CHARS,
  MEMORY_TITLE_MAX,
  MEMORY_CONTENT_MAX,
  MEMORY_DORMANT_AFTER_DAYS,
  validateMemoryText,
  redactEvidence,
  type MemoryTextValidation,
} from './memory-limits.js';

/** Memories older than this get a "recorded N ago" marker so the model can discount them. */
const STALE_MARKER_AFTER_DAYS = 30;

/** Users below this many active memories aren't worth a consolidation call. */
const CONSOLIDATION_MIN_ACTIVE = 10;

/** Upkeep runs on the cheap catalog model; `id` is what selects the provider chain. */
// Registry id resolves the real provider/model at call time; the literal
// provider/model fields are placeholders the kernel ignores for registry ids.
const CONSOLIDATION_MODEL: ModelConfig = { id: 'flash', provider: 'openai-compatible', model: 'flash' };

// ─── Recall index ────────────────────────────────────────

function ageMarker(row: UserMemoryRow, now: number): string {
  const stamp = row.last_used_at ?? row.created_at;
  const days = Math.floor((now - new Date(stamp).getTime()) / (24 * 60 * 60 * 1000));
  if (days < STALE_MARKER_AFTER_DAYS) return '';
  if (days < 365) return ` (recorded ~${Math.round(days / 30)} months ago)`;
  return ` (recorded over a year ago)`;
}

/**
 * Build the `## User Memory` block for a system prompt.
 *
 * Titles only, pinned first, newest-used next, cut off at a hard character
 * budget. Everything is sanitised: memory text is model-written and
 * user-editable, so it is untrusted input that gets replayed every turn.
 */
export async function buildMemoryIndexBlock(userId: string): Promise<string | null> {
  const db = getDb();
  const rows = await db.userMemories.listForIndex(userId);
  if (rows.length === 0) return null;

  const now = Date.now();
  const lines: string[] = [];
  let used = 0;
  let dropped = 0;

  for (const row of rows) {
    const line = `- [${row.category}] ${sanitizeForPrompt(row.title)}${ageMarker(row, now)} (id: ${row.id})`;
    if (used + line.length > MEMORY_INDEX_BUDGET_CHARS) {
      dropped++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }

  if (lines.length === 0) return null;

  const overflow =
    dropped > 0
      ? `\n${dropped} older ${dropped === 1 ? 'memory is' : 'memories are'} not listed — use memory(action:"recall", query:"…") to search them.`
      : '';

  return (
    `What you remember about this user, one line each. These are point-in-time notes, not live state — ` +
    `re-check anything that may have changed. Use them to personalise your answers without announcing that you ` +
    `"remember"; call memory(action:"recall", ids:[…]) to read the full note when a line looks relevant.\n` +
    lines.join('\n') +
    overflow
  );
}

/**
 * The memory section for a system prompt: feature gate, index, heading.
 *
 * The single entry point for every prompt-assembly site (chat, scheduled tasks,
 * spawned subagents). Returns null when the feature is off, the user is unknown,
 * or anything at all fails — memory must never be the reason a turn breaks.
 */
export async function resolveMemoryContext(userId: string, role?: UserRole): Promise<string | null> {
  try {
    const db = getDb();
    let userRole = role;
    if (!userRole) {
      const user = await db.users.getById(userId);
      if (!user) return null;
      userRole = user.role as UserRole;
    }
    if (!(await userHasFeature(userId, userRole, 'memory'))) return null;

    const index = await buildMemoryIndexBlock(userId);
    return index ? `### Memory\n${index}` : null;
  } catch (err) {
    logger.warn('[memory] failed to build memory context', { error: toErrorMessage(err) });
    return null;
  }
}

// ─── Weekly consolidation ────────────────────────────────

const CONSOLIDATION_SYSTEM_PROMPT = `You are the upkeep pass over one user's stored memories. You NEVER invent new information — you only reorganise what is already there.

You receive a numbered list of memories, each with an id, category, title and content.

Return a JSON array of operations. Valid operations:
- {"op":"merge","ids":[<ids>],"title":"...","content":"...","category":"preference|fact|behavior"} — two or more memories say the same thing. Write one replacement that keeps every distinct detail; the originals are retired.
- {"op":"supersede","old_id":<id>,"new_id":<id>} — two memories contradict each other and one is clearly the newer truth. Keep new_id, retire old_id.
- {"op":"demote","id":<id>} — this was a one-off task detail or is plainly obsolete, and is not worth keeping active.

Rules:
- Write in English. Keep proper nouns and literal values (identifiers, enum values such as 潜在, document titles, customer names, error strings) EXACTLY as they appear — never translate them.
- A merged title must be one line, under 80 characters, and written so a reader can judge relevance without opening the body.
- Be conservative. If two memories are merely related, leave them alone. Prefer returning [] over a speculative edit.
- Never merge or demote a memory marked [pinned].
- Output ONLY the JSON array.`;

interface ConsolidationOp {
  op: 'merge' | 'supersede' | 'demote';
  ids?: number[];
  title?: string;
  content?: string;
  category?: string;
  old_id?: number;
  new_id?: number;
}

const VALID_CATEGORIES = new Set(['preference', 'fact', 'behavior']);

/** Parse + shape-check the model's operation list. Anything malformed is dropped. */
export function parseConsolidationOps(raw: string, knownIds: Set<number>): ConsolidationOp[] {
  const jsonStr = extractJson(raw);
  if (!jsonStr) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const ops: ConsolidationOp[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const op = item as Record<string, unknown>;

    if (op.op === 'merge') {
      const ids = Array.isArray(op.ids) ? op.ids.filter((n): n is number => typeof n === 'number') : [];
      const title = typeof op.title === 'string' ? op.title.trim() : '';
      const content = typeof op.content === 'string' ? op.content.trim() : '';
      const category = typeof op.category === 'string' && VALID_CATEGORIES.has(op.category) ? op.category : 'fact';
      if (ids.length < 2 || !ids.every((id) => knownIds.has(id)) || !title || !content) continue;
      if (!validateMemoryText({ title, content }).ok) continue;
      ops.push({ op: 'merge', ids, title, content, category });
      continue;
    }

    if (op.op === 'supersede') {
      const oldId = typeof op.old_id === 'number' ? op.old_id : undefined;
      const newId = typeof op.new_id === 'number' ? op.new_id : undefined;
      if (oldId === undefined || newId === undefined || oldId === newId) continue;
      if (!knownIds.has(oldId) || !knownIds.has(newId)) continue;
      ops.push({ op: 'supersede', old_id: oldId, new_id: newId });
      continue;
    }

    if (op.op === 'demote') {
      const id = typeof op.id === 'number' ? op.id : undefined;
      if (id === undefined || !knownIds.has(id)) continue;
      ops.push({ op: 'demote', ids: [id] });
    }
  }
  return ops;
}

async function consolidateUser(userId: string): Promise<number> {
  const db = getDb();
  const rows = await db.userMemories.listForIndex(userId);
  if (rows.length < CONSOLIDATION_MIN_ACTIVE) return 0;

  // Pinned rows are shown for context but may not be merged or demoted.
  const listing = rows
    .map(
      (r) =>
        `id=${r.id}${r.pinned ? ' [pinned]' : ''} category=${r.category}\ntitle: ${r.title}\ncontent: ${r.content}`,
    )
    .join('\n\n');

  // Catalog entry, not a pinned provider: `id` drives registry resolution (and
  // its fallback chain), resolveModelConfig layers the catalog's sampling
  // options, buildProviderOptions keeps provider-specific flags matched to
  // whichever provider actually answers.
  const modelConfig = resolveModelConfig(CONSOLIDATION_MODEL);
  const messages = [{ role: 'user' as const, content: `Memories:\n\n${listing}` }];
  const providerAttemptHook = createProviderAttemptBudgetHook({
    db,
    userId,
    caller: 'memory-consolidation',
    profileId: 'system',
    metadata: { active_memory_count: rows.length },
  });
  const model = await createModelFromConfig(modelConfig, { onProviderAttempt: providerAttemptHook });

  const result = await generateText({
    model,
    system: CONSOLIDATION_SYSTEM_PROMPT,
    messages,
    temperature: 0.1,
    maxOutputTokens: 1500,
    maxRetries: 1,
    providerOptions: buildProviderOptions(modelConfig),
  });

  const pinned = new Set(rows.filter((r) => r.pinned).map((r) => r.id));
  const ops = parseConsolidationOps(result.text, new Set(rows.map((r) => r.id)));
  let applied = 0;

  for (const op of ops) {
    try {
      if (op.op === 'merge') {
        const targets = (op.ids ?? []).filter((id) => !pinned.has(id));
        if (targets.length < 2) continue;
        const replacement = await db.userMemories.create({
          user_id: userId,
          category: op.category as 'preference' | 'fact' | 'behavior',
          title: op.title!,
          content: op.content!,
          source: 'consolidation',
        });
        for (const id of targets) {
          await db.userMemories.setStatus(id, userId, 'superseded', replacement.id);
        }
        applied++;
      } else if (op.op === 'supersede') {
        if (pinned.has(op.old_id!)) continue;
        await db.userMemories.setStatus(op.old_id!, userId, 'superseded', op.new_id!);
        applied++;
      } else if (op.op === 'demote') {
        const id = op.ids![0]!;
        if (pinned.has(id)) continue;
        await db.userMemories.setStatus(id, userId, 'archived');
        applied++;
      }
    } catch (err) {
      logger.warn('[memory] consolidation op failed', { userId, op: op.op, error: toErrorMessage(err) });
    }
  }

  return applied;
}

/**
 * Weekly upkeep: demote stale memories everywhere, then run the merge pass for
 * users who have enough active memories for it to be worth a model call.
 */
export async function runMemoryConsolidation(): Promise<{
  demoted: number;
  usersProcessed: number;
  opsApplied: number;
}> {
  const db = getDb();
  const stats = { demoted: 0, usersProcessed: 0, opsApplied: 0 };

  stats.demoted = await db.userMemories.demoteStale();

  const candidates = await db.userMemories.listUsersForConsolidation(CONSOLIDATION_MIN_ACTIVE);
  for (const candidate of candidates) {
    try {
      const user = await db.users.getById(candidate.user_id);
      if (!user || user.status !== 'active') continue;
      if (!(await userHasFeature(user.id, user.role as UserRole, 'memory'))) continue;

      const applied = await consolidateUser(candidate.user_id);
      stats.usersProcessed++;
      stats.opsApplied += applied;
    } catch (err) {
      // Leave the user unmarked so the next run retries them.
      logger.warn('[memory] consolidation failed for user', {
        userId: candidate.user_id,
        error: toErrorMessage(err),
      });
    }
  }

  return stats;
}
