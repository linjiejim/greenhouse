/**
 * Friction center — the single implementation behind every friction writer.
 *
 * A "friction" is the agent stumbling: a tool erroring, a wrong parameter shape
 * learned the hard way, three turns of exploration to find something obvious.
 * These are collected for a human to fix at the harness layer (tool description,
 * tool implementation, prompt, skill, code) — nothing here is ever injected back
 * into a prompt.
 *
 * Two writers, one implementation:
 *   • mineToolErrors()  — daily sweep over messages.pipeline (no LLM, pure SQL
 *     plus string normalisation), so a friction is recorded even when the model
 *     never notices it stumbled.
 *   • recordFriction()  — the `log_friction` tool, for detours that produced no
 *     error at all.
 *
 * Both converge on one row per fingerprint, so the occurrence count is a real
 * priority signal.
 */

import { createHash } from 'node:crypto';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import type { DatabaseProvider, ToolFrictionKind, ToolFrictionRow } from '@greenhouse/db';
import { redactEvidence } from '../llm/memory-limits.js';
import { FRICTION_SUMMARY_MAX, FRICTION_DETAIL_MAX } from './friction-limits.js';

/** How far back the daily miner looks. Slightly over 24h so a late run misses nothing. */
const MINE_WINDOW_HOURS = 25;

/** Ceiling on rows pulled per sweep — this is a signal, not a ledger. */
const MINE_ROW_LIMIT = 2000;

/**
 * Collapse an error message to its shape so the same failure lands on one row:
 * ids, uuids, numbers, quoted values and timestamps all become placeholders.
 */
export function normalizeErrorText(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}(?:[t ][\d:.]+z?)?/g, '<date>')
    .replace(/"[^"]*"/g, '<value>')
    .replace(/'[^']*'/g, '<value>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/** Stable aggregation key. Same tool + same kind + same error shape → same row. */
export function fingerprintFriction(input: { tool_id?: string | null; kind: string; signature: string }): string {
  const basis = `${input.tool_id ?? '-'}|${input.kind}|${normalizeErrorText(input.signature)}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 32);
}

export interface RecordFrictionInput {
  tool_id?: string | null;
  kind: ToolFrictionKind;
  summary: string;
  detail?: string;
  session_id?: string;
}

export type RecordFrictionResult =
  | { ok: true; friction: ToolFrictionRow }
  | { ok: false; code: 'invalid'; error: string };

/**
 * Record one friction. Evidence is redacted (not rejected) — unlike a memory,
 * a friction sample is raw tool I/O whose diagnostic value is the whole point.
 */
export async function recordFriction(db: DatabaseProvider, input: RecordFrictionInput): Promise<RecordFrictionResult> {
  const summary = input.summary?.trim();
  if (!summary) return { ok: false, code: 'invalid', error: 'summary is required' };
  if (summary.length > FRICTION_SUMMARY_MAX) {
    return { ok: false, code: 'invalid', error: `summary must be ${FRICTION_SUMMARY_MAX} characters or fewer` };
  }

  const detail = input.detail ? redactEvidence(input.detail).slice(0, FRICTION_DETAIL_MAX) : undefined;
  const fingerprint = fingerprintFriction({
    tool_id: input.tool_id,
    kind: input.kind,
    signature: summary,
  });

  const friction = await db.toolFrictions.record({
    fingerprint,
    tool_id: input.tool_id ?? null,
    kind: input.kind,
    summary: redactEvidence(summary),
    detail,
    session_id: input.session_id,
  });
  return { ok: true, friction };
}

/**
 * Sweep recent tool errors out of message pipelines into friction rows.
 *
 * Counts are deliberately approximate: the window overlaps by an hour, so a
 * restart can double-count a boundary error. The count orders a review queue —
 * making it exact would mean a per-message cursor for no decision-changing gain.
 */
export async function mineToolErrors(
  db: DatabaseProvider,
  opts: { windowHours?: number; limit?: number } = {},
): Promise<{ scanned: number; fingerprints: number; occurrences: number }> {
  const windowHours = opts.windowHours ?? MINE_WINDOW_HOURS;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const samples = await db.sessions.scanToolErrors(since, opts.limit ?? MINE_ROW_LIMIT);
  const stats = { scanned: samples.length, fingerprints: 0, occurrences: 0 };
  if (samples.length === 0) return stats;

  // Group first so each distinct stumble is one write carrying its true count.
  const grouped = new Map<string, { tool: string; error: string; input?: string; session_id: string; count: number }>();

  for (const sample of samples) {
    const fingerprint = fingerprintFriction({
      tool_id: sample.tool,
      kind: 'tool_error',
      signature: sample.error,
    });
    const existing = grouped.get(fingerprint);
    if (existing) {
      existing.count++;
    } else {
      grouped.set(fingerprint, {
        tool: sample.tool,
        error: sample.error,
        input: sample.input,
        session_id: sample.session_id,
        count: 1,
      });
    }
  }

  for (const [fingerprint, group] of grouped) {
    try {
      const evidence = group.input ? `error: ${group.error}\ncall input: ${group.input}` : `error: ${group.error}`;

      await db.toolFrictions.record({
        fingerprint,
        tool_id: group.tool,
        kind: 'tool_error',
        summary: redactEvidence(group.error).slice(0, FRICTION_SUMMARY_MAX),
        detail: redactEvidence(evidence).slice(0, FRICTION_DETAIL_MAX),
        session_id: group.session_id,
        increment: group.count,
      });
      stats.fingerprints++;
      stats.occurrences += group.count;
    } catch (err) {
      logger.warn('[frictions] failed to record mined friction', {
        tool: group.tool,
        error: toErrorMessage(err),
      });
    }
  }

  return stats;
}

/**
 * Retrieval tools whose empty result is worth reviewing. Deliberately a short
 * allowlist rather than "anything with found:0": a CRM filter or an automation
 * list matching nothing is usually a correct answer, while a knowledge search
 * finding nothing is either a content gap or a retrieval gap — both actionable.
 */
const RETRIEVAL_TOOL_IDS = new Set(['knowledge_query']);

/** Example queries kept as evidence per tool, per sweep. */
const EMPTY_SEARCH_SAMPLE_QUERIES = 8;

/**
 * Sweep searches that succeeded and found nothing.
 *
 * Errors are not the only way a tool fails the user, and for retrieval they are
 * the rarer way: `found: 0` returns cleanly, the model moves on, and nobody
 * learns that the library could not answer. Fingerprinting is per TOOL, not per
 * query — one row per retrieval surface whose count says how often it comes up
 * empty, with the actual queries as evidence. Fingerprinting per query would
 * spread one real problem ("nobody can find the refund policy") across dozens
 * of singleton rows, which is exactly the mistake the un-quoted error values
 * made in 2026-08.
 */
export async function mineEmptySearches(
  db: DatabaseProvider,
  opts: { windowHours?: number; limit?: number } = {},
): Promise<{ scanned: number; fingerprints: number; occurrences: number }> {
  const windowHours = opts.windowHours ?? MINE_WINDOW_HOURS;
  const since = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const samples = (await db.sessions.scanEmptyResults(since, opts.limit ?? MINE_ROW_LIMIT)).filter((s) =>
    RETRIEVAL_TOOL_IDS.has(s.tool),
  );
  const stats = { scanned: samples.length, fingerprints: 0, occurrences: 0 };
  if (samples.length === 0) return stats;

  const grouped = new Map<string, { tool: string; queries: string[]; session_id: string; count: number }>();
  for (const sample of samples) {
    const fingerprint = fingerprintFriction({
      tool_id: sample.tool,
      kind: 'capability_gap',
      signature: 'search returned no results',
    });
    const existing = grouped.get(fingerprint);
    const query = sample.input ?? '';
    if (existing) {
      existing.count++;
      if (query && existing.queries.length < EMPTY_SEARCH_SAMPLE_QUERIES) existing.queries.push(query);
    } else {
      grouped.set(fingerprint, {
        tool: sample.tool,
        queries: query ? [query] : [],
        session_id: sample.session_id,
        count: 1,
      });
    }
  }

  for (const [fingerprint, group] of grouped) {
    try {
      await db.toolFrictions.record({
        fingerprint,
        tool_id: group.tool,
        kind: 'capability_gap',
        summary: `"${group.tool}" search returned no results`,
        detail: redactEvidence(`queries that found nothing:\n${group.queries.join('\n')}`).slice(
          0,
          FRICTION_DETAIL_MAX,
        ),
        session_id: group.session_id,
        increment: group.count,
      });
      stats.fingerprints++;
      stats.occurrences += group.count;
    } catch (err) {
      logger.warn('[frictions] failed to record empty-search friction', {
        tool: group.tool,
        error: toErrorMessage(err),
      });
    }
  }

  return stats;
}
