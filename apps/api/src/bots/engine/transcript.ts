/**
 * Reading a Bots transcript — the unsummarised tail, recall search, previews.
 *
 * Reads go through `db.sessions.getMessagePage` (newest first, bounded pages)
 * so a conversation that has run for months never loads whole: the engine only
 * needs the rows after the digest boundary, and those are kept small by the
 * digest (spec §4.5). Hard caps make a failed digest degrade into a window,
 * never into an unbounded read.
 */

import type { DatabaseProvider } from '@greenhouse/db';
import type { BotEvent } from '@greenhouse/types/bots';
import type { MessageRow } from '@greenhouse/types/session';
import { safeJsonParse } from '@greenhouse/utils/json';
import { estimateTokens } from '@greenhouse/agent-core';
import type { ProjectionRow } from './projection.js';

const PAGE_SIZE = 200;
/** Stop reading older pages once this many rows / estimated tokens are in hand. */
const TAIL_MAX_ROWS = 1200;
const TAIL_MAX_TOKENS = 160_000;

export function parseBotEvent(raw: string | null | undefined): BotEvent | null {
  if (!raw) return null;
  const parsed = safeJsonParse(raw, null) as BotEvent | null;
  return parsed && typeof parsed === 'object' && typeof (parsed as { kind?: unknown }).kind === 'string'
    ? parsed
    : null;
}

/**
 * A member's attached images reach the model as IDs (the same contract as
 * Chat's non-vision path): `analyze_image` can open them when the Bot has it.
 */
function withImageHint(row: MessageRow): string {
  if (row.role !== 'user') return row.content;
  const images = safeJsonParse(row.images, []) as Array<{ id?: unknown }>;
  const ids = Array.isArray(images)
    ? images.map((image) => (typeof image?.id === 'string' ? image.id.slice(0, 256) : '')).filter(Boolean)
    : [];
  return ids.length ? `${row.content}\n\n[Attached image ID(s): ${ids.join(', ')}.]` : row.content;
}

export function toProjectionRow(row: MessageRow): ProjectionRow {
  return {
    id: row.id,
    seq: row.seq,
    role: row.role,
    content: withImageHint(row),
    bot_id: row.bot_id ?? null,
    bot_event: parseBotEvent(row.bot_event),
  };
}

export interface TailRead {
  rows: ProjectionRow[];
  /** True when the caps stopped the read before reaching the digest boundary. */
  truncated: boolean;
}

/** Rows with seq > uptoSeq, oldest first. */
export async function readTail(db: DatabaseProvider, sessionId: string, uptoSeq: number): Promise<TailRead> {
  const collected: MessageRow[] = [];
  let beforeSeq: number | undefined;
  let tokens = 0;
  for (;;) {
    const page = await db.sessions.getMessagePage(sessionId, {
      limit: PAGE_SIZE,
      ...(beforeSeq !== undefined ? { beforeSeq } : {}),
    });
    const newestFirst = [...page.messages].reverse();
    let reachedBoundary = false;
    for (const row of newestFirst) {
      if (row.seq <= uptoSeq) {
        reachedBoundary = true;
        break;
      }
      collected.push(row);
      tokens += estimateTokens(row.content);
    }
    if (reachedBoundary || !page.has_more || page.next_before_seq === null) {
      return { rows: collected.reverse().map(toProjectionRow), truncated: false };
    }
    if (collected.length >= TAIL_MAX_ROWS || tokens >= TAIL_MAX_TOKENS) {
      return { rows: collected.reverse().map(toProjectionRow), truncated: true };
    }
    beforeSeq = page.next_before_seq;
  }
}

/**
 * Rows after `afterSeq` (and before `beforeSeq`), OLDEST first, until about
 * `maxTokens` are in hand — what a compaction folds when the tail is too big
 * to fold in one go (readTail keeps the newest rows; folding those would skip
 * the middle for good). Reads forward in seq windows: message seqs are unique
 * per conversation, so the newest `PAGE_SIZE` rows below `cursor + 1 +
 * PAGE_SIZE` are exactly the rows of that window.
 */
export async function readFromBoundary(
  db: DatabaseProvider,
  sessionId: string,
  afterSeq: number,
  opts: { maxTokens: number; beforeSeq?: number },
): Promise<{ rows: ProjectionRow[]; complete: boolean }> {
  const latest = await db.sessions.getLatestMessage(sessionId);
  const end = Math.min(latest?.seq ?? -1, (opts.beforeSeq ?? Number.MAX_SAFE_INTEGER) - 1);
  const collected: MessageRow[] = [];
  let tokens = 0;
  for (let cursor = afterSeq; cursor < end; cursor += PAGE_SIZE) {
    const page = await db.sessions.getMessagePage(sessionId, { limit: PAGE_SIZE, beforeSeq: cursor + 1 + PAGE_SIZE });
    for (const row of page.messages) {
      if (row.seq <= cursor || row.seq > end) continue;
      const cost = estimateTokens(row.content) + 8;
      if (collected.length > 0 && tokens + cost > opts.maxTokens) {
        return { rows: collected.map(toProjectionRow), complete: false };
      }
      collected.push(row);
      tokens += cost;
    }
  }
  return { rows: collected.map(toProjectionRow), complete: true };
}

/** Estimated tokens of a tail (what the digest trigger and the context meter compare). */
export function estimateRows(rows: readonly ProjectionRow[]): number {
  let total = 0;
  for (const row of rows) total += estimateTokens(row.content) + 8;
  return total;
}

// ─── Recall ──────────────────────────────────────────────

export interface RecallHit {
  seq: number;
  date: string;
  speaker: string;
  snippet: string;
}

/** Rows scanned per recall at most (newest first below the boundary). */
const RECALL_SCAN_ROWS = 2000;
const SNIPPET_RADIUS = 140;

function snippetAround(content: string, needle: string): string {
  const lower = content.toLowerCase();
  const at = lower.indexOf(needle);
  const start = Math.max(0, at - SNIPPET_RADIUS);
  const end = Math.min(content.length, at + needle.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${content.slice(start, end).replace(/\s+/g, ' ').trim()}${end < content.length ? '…' : ''}`;
}

/**
 * Case-insensitive search over this conversation's messages up to `maxSeq`
 * (the part that is no longer in the Bot's context). Terms are AND-ed.
 */
export async function recallMessages(
  db: DatabaseProvider,
  sessionId: string,
  query: string,
  opts: { maxSeq: number; limit: number; speakerOf: (row: MessageRow) => string },
): Promise<{ hits: RecallHit[]; scanned: number; capped: boolean }> {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  if (terms.length === 0 || opts.maxSeq < 0) return { hits: [], scanned: 0, capped: false };
  const hits: RecallHit[] = [];
  let scanned = 0;
  let beforeSeq: number | undefined = opts.maxSeq + 1;
  while (beforeSeq !== undefined && scanned < RECALL_SCAN_ROWS && hits.length < opts.limit) {
    const page = await db.sessions.getMessagePage(sessionId, { limit: PAGE_SIZE, beforeSeq });
    const newestFirst = [...page.messages].reverse();
    for (const row of newestFirst) {
      scanned += 1;
      const lower = row.content.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      hits.push({
        seq: row.seq,
        date: row.created_at.slice(0, 10),
        speaker: opts.speakerOf(row),
        snippet: snippetAround(row.content, terms[0]!),
      });
      if (hits.length >= opts.limit) break;
    }
    beforeSeq = page.has_more && page.next_before_seq !== null ? page.next_before_seq : undefined;
  }
  return { hits, scanned, capped: beforeSeq !== undefined && scanned >= RECALL_SCAN_ROWS };
}
