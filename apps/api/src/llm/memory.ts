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
  runsDeepSeekThinking,
  type ModelConfig,
} from '@greenhouse/agent-core';
import { logger } from '@greenhouse/utils/logger';
import { extractJson } from '@greenhouse/utils/json';
import { getDb, type UserMemoryRow } from '@greenhouse/db';
import { sanitizeForPrompt } from '../security/security.js';
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

/** Budget split when a Bot reads both layers: user-level first, then its own notes. */
const BOT_PRIVATE_INDEX_BUDGET_CHARS = 1200;

/**
 * WHICH memories make the index is decided by recency (`rows` arrive pinned
 * first, then most recently used); the order they are WRITTEN in is stable —
 * pinned first, then by id. Recall touches `last_used_at`, so rendering in
 * recency order rewrote the system prompt (and lost the provider's prefix
 * cache for the whole conversation) after every recall even when the same
 * memories were listed (spec 20261009 D7).
 */
function renderIndexLines(rows: UserMemoryRow[], budget: number, now: number): { lines: string[]; dropped: number } {
  const selected: Array<{ row: UserMemoryRow; line: string }> = [];
  let used = 0;
  let dropped = 0;
  for (const row of rows) {
    const line = `- [${row.category}] ${sanitizeForPrompt(row.title)}${ageMarker(row, now)} (id: ${row.id})`;
    if (used + line.length > budget) {
      dropped++;
      continue;
    }
    selected.push({ row, line });
    used += line.length + 1;
  }
  selected.sort((a, b) => Number(b.row.pinned) - Number(a.row.pinned) || a.row.id - b.row.id);
  return { lines: selected.map((entry) => entry.line), dropped };
}

/**
 * Build the `## User Memory` block for a system prompt.
 *
 * Titles only: the most recently used fit the hard character budget, and are
 * listed in a stable order (pinned first, then by id) so a recall does not
 * rewrite the prompt prefix. Everything is sanitised: memory text is model-written and
 * user-editable, so it is untrusted input that gets replayed every turn.
 *
 * Without a Bot the block holds user-level memories only. A Bot reads the
 * user-level layer plus its own private notes, under a split budget; it never
 * sees another Bot's private memories.
 */
export async function buildMemoryIndexBlock(
  userId: string,
  opts: { botId?: string | null } = {},
): Promise<string | null> {
  const db = getDb();
  const botId = opts.botId ?? null;
  const userRows = await db.userMemories.listForIndex(userId, { botId: null });
  const botRows = botId ? await db.userMemories.listForIndex(userId, { botId, exact: true }) : [];
  if (userRows.length === 0 && botRows.length === 0) return null;

  const now = Date.now();
  const userBudget = botId ? MEMORY_INDEX_BUDGET_CHARS - BOT_PRIVATE_INDEX_BUDGET_CHARS : MEMORY_INDEX_BUDGET_CHARS;
  const userPart = renderIndexLines(userRows, userBudget, now);
  const botPart = botId ? renderIndexLines(botRows, BOT_PRIVATE_INDEX_BUDGET_CHARS, now) : { lines: [], dropped: 0 };
  if (userPart.lines.length === 0 && botPart.lines.length === 0) return null;

  const dropped = userPart.dropped + botPart.dropped;
  const overflow =
    dropped > 0
      ? `\n${dropped} older ${dropped === 1 ? 'memory is' : 'memories are'} not listed — use memory(action:"recall", query:"…") to search them.`
      : '';

  const sections = [userPart.lines.join('\n')];
  if (botPart.lines.length > 0) {
    sections.push(`Your own private notes (only you see these):\n${botPart.lines.join('\n')}`);
  }

  return (
    `What you remember about this user, one line each. These are point-in-time notes, not live state — ` +
    `re-check anything that may have changed. Use them to personalise your answers without announcing that you ` +
    `"remember"; call memory(action:"recall", ids:[…]) to read the full note when a line looks relevant.\n` +
    sections.filter(Boolean).join('\n') +
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
export async function resolveMemoryContext(
  userId: string,
  role?: UserRole,
  opts: { botId?: string | null } = {},
): Promise<string | null> {
  try {
    const db = getDb();
    let userRole = role;
    if (!userRole) {
      const user = await db.users.getById(userId);
      if (!user) return null;
      userRole = user.role as UserRole;
    }
    if (!(await userHasFeature(userId, userRole, 'memory'))) return null;

    const index = await buildMemoryIndexBlock(userId, opts);
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
- A merge keeps every negation, limit and number from its sources word for word ("never", "not", "不", "不超过", "5 columns", dates). A merge that would soften or drop one is not a merge — leave those memories alone.
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

// ─── Anti-dilution (spec 20261009 D7) ───────────────────

/** Negations and limits whose loss inverts or widens a memory. */
const NEGATION =
  /\b(?:not|never|no|don't|doesn't|didn't|won't|can't|cannot|isn't|aren't|shouldn't|mustn't|avoid|without|except|unless|only)\b|不|没|别|勿|未|禁止|避免|除了|无需/gi;
const NUMBER = /\d+(?:[.,:/-]\d+)*%?/g;

function negationCount(text: string): number {
  return text.match(NEGATION)?.length ?? 0;
}

/**
 * Why a merged memory would lose meaning its sources carried, or null.
 *
 * A merge is an LLM rewrite of user facts. The failure that matters is
 * dilution: "never send reports on Friday" + "no Friday reports" merged into
 * "send weekly reports", or "表格不超过五列" losing its limit — a memory that
 * now says the opposite and is replayed in every future conversation. Octop
 * Memory pins high-importance assertions to the user's own words for the same
 * reason. Checked deterministically: the merge must keep as many negations as
 * its most negated source, and every number any source states.
 */
export function mergeDilutes(sources: readonly string[], merged: string): string | null {
  const needed = Math.max(0, ...sources.map(negationCount));
  if (negationCount(merged) < needed) return 'drops a negation or limit';
  const kept = new Set(merged.match(NUMBER) ?? []);
  const lost = [...new Set(sources.flatMap((text) => text.match(NUMBER) ?? []))].filter((n) => !kept.has(n));
  if (lost.length > 0)
    return `drops ${lost
      .slice(0, 3)
      .map((n) => `"${n}"`)
      .join(', ')}`;
  return null;
}

/**
 * Parse + shape-check the model's operation list. Anything malformed is
 * dropped, and so is a merge that dilutes its sources (`sourceText`: id →
 * title + content of every listed memory).
 */
export function parseConsolidationOps(
  raw: string,
  knownIds: Set<number>,
  sourceText: ReadonlyMap<number, string> = new Map(),
): ConsolidationOp[] {
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
      const sources = ids.map((id) => sourceText.get(id)).filter((text): text is string => text !== undefined);
      const dilution = sources.length > 0 ? mergeDilutes(sources, `${title}\n${content}`) : null;
      if (dilution) {
        logger.info('[memory] consolidation merge refused — it would dilute its sources', { ids, reason: dilution });
        continue;
      }
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

/**
 * Consolidate one user, one scope partition at a time: user-level memories and
 * each Bot's private memories are separate lists, and a merge never crosses
 * them (a replacement inherits its partition's bot_id).
 */
async function consolidateUser(userId: string): Promise<number> {
  const db = getDb();
  const scopes = await db.userMemories.listActiveScopes(userId, CONSOLIDATION_MIN_ACTIVE);
  let applied = 0;
  for (const scope of scopes) {
    applied += await consolidatePartition(userId, scope.bot_id);
  }
  return applied;
}

async function consolidatePartition(userId: string, botId: string | null): Promise<number> {
  const db = getDb();
  const rows = await db.userMemories.listForIndex(userId, { botId, exact: true });
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
    instructions: CONSOLIDATION_SYSTEM_PROMPT,
    messages,
    // DeepSeek ignores temperature while it thinks (and warns when sent).
    ...(runsDeepSeekThinking(modelConfig) ? {} : { temperature: 0.1 }),
    maxOutputTokens: 1500,
    maxRetries: 1,
    providerOptions: buildProviderOptions(modelConfig),
  });

  const pinned = new Set(rows.filter((r) => r.pinned).map((r) => r.id));
  const ops = parseConsolidationOps(
    result.text,
    new Set(rows.map((r) => r.id)),
    new Map(rows.map((r) => [r.id, `${r.title}\n${r.content}`])),
  );
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
          bot_id: botId,
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
