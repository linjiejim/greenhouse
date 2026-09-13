/**
 * Shared PostgreSQL full-text-search helpers — segmentation-based.
 *
 * Chinese is the primary content language for the internal knowledge base and
 * inquiry knowledge. Postgres' 'simple'/'english' text-search parsers do NOT
 * word-segment CJK (a whole Chinese sentence collapses to one token), so we
 * segment on the application side with jieba and store the space-joined tokens
 * in dedicated `_tokens_a/b/c` columns. Both the stored tokens and the query
 * MUST go through the SAME `segmentForFts()` so they align.
 *
 * Segmentation rule: jieba cuts the whole string; latin words / numbers survive
 * as-is (lowercased), pure punctuation/whitespace tokens are dropped. Device
 * codes like `LPH64` stay intact (jieba keeps the alphanumeric run together).
 *
 * Used by the knowledge-base and inquiry-knowledge services (write path recomputes
 * the token columns; query path segments the query the same way). `search.ts`
 * (the public `sources` table) stays on 'english' with its own richer builder.
 */

import { Jieba } from '@node-rs/jieba';
import { dict } from '@node-rs/jieba/dict.js';

let _jieba: Jieba | null = null;

/** Lazily-initialised jieba instance (dict load is ~tens of MB, done once). */
function jieba(): Jieba {
  if (!_jieba) _jieba = Jieba.withDict(dict);
  return _jieba;
}

const HAS_WORD_CHAR = /[\p{L}\p{N}]/u;

/**
 * Segment free text into a space-joined token string suitable for
 * `to_tsvector('simple', …)`. Deterministic and pure (no DB, no I/O beyond the
 * in-process dict), so it is safe to call on both the write and query paths and
 * to unit-test directly.
 *
 * `segmentForFts('LPH64水位低报警')` → `'lph64 水位 低 报警'`.
 */
export function segmentForFts(input: string | null | undefined): string {
  if (!input) return '';
  const tokens: string[] = [];
  for (const raw of jieba().cut(input, false)) {
    const t = raw.toLowerCase().trim();
    // Drop tokens that are pure punctuation / whitespace; keep anything with a
    // letter, digit or CJK character.
    if (t && HAS_WORD_CHAR.test(t)) tokens.push(t);
  }
  return tokens.join(' ');
}

/**
 * Build a prefix-match `to_tsquery` string from a free-text query, segmenting it
 * first so it aligns with the stored `_tokens_*` columns.
 *
 * @param op '&' for AND (precision) or '|' for OR (recall).
 * Returns null when nothing usable remains — callers fall back to ILIKE.
 */
export function buildSegmentedTsQuery(query: string, op: '&' | '|'): string | null {
  const words = segmentForFts(query)
    .split(/\s+/)
    // Strip any residual tsquery-significant punctuation defensively; tokens are
    // already lowercased and space-separated by segmentForFts.
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter(Boolean);
  if (words.length === 0) return null;
  return words.map((w) => `${w}:*`).join(` ${op} `);
}

/**
 * App-layer snippet for CJK hits. `ts_headline` re-parses the RAW content with
 * the 'simple' parser (no CJK segmentation), so it cannot align with a segmented
 * query — it would highlight nothing for Chinese. Instead we locate the first
 * matching segmented token in the original content and slice a window around it.
 */
export function buildSnippet(content: string | null | undefined, query: string, opts?: { window?: number }): string {
  if (!content) return '';
  const win = opts?.window ?? 200;
  const tokens = segmentForFts(query).split(/\s+/).filter(Boolean);
  const lower = content.toLowerCase();
  let hit = -1;
  for (const tok of tokens) {
    const i = lower.indexOf(tok);
    if (i >= 0 && (hit < 0 || i < hit)) hit = i;
  }
  if (hit < 0) return content.slice(0, win).trim();
  const start = Math.max(0, hit - Math.floor(win / 4));
  const end = Math.min(content.length, start + win);
  return `${start > 0 ? '…' : ''}${content.slice(start, end).trim()}${end < content.length ? '…' : ''}`;
}

/**
 * Extract plain text from a JSON-array-as-text column (tags / _questions /
 * _topics) for segmentation. Returns a space-joined string; tolerates malformed
 * JSON by returning the raw string.
 */
export function jsonArrayToText(raw: string | null | undefined): string {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((v) => typeof v === 'string').join(' ');
  } catch {
    /* fall through */
  }
  return raw;
}
