/**
 * Comparing two versions of a doc (KNOW-07): Myers' diff over lines, and inside each changed
 * stretch over words (single characters for Chinese). The answer stays small: two lines of
 * context, long unchanged text shortened, and at most so many hunks.
 */

import type { DocDiff } from '@greenhouse/contract';

export type DiffOp = 'equal' | 'insert' | 'delete';
export interface DiffPart {
  op: DiffOp;
  text: string;
}
type Hunk = DocDiff['hunks'][number];

const CONTEXT_LINES = 2;
const MAX_HUNKS = 100;
const MAX_TEXT = 30_000;
/** Unchanged text longer than this keeps its ends only. */
const MAX_EQUAL = 300;
/** Past this many edits the two texts are reported as replaced wholesale. */
const MAX_EDITS = 2_000;
/**
 * Lines or words a fine diff compares at most once their common ends are set aside: its cost
 * grows with their number times the edits. Past it, the middle is reported as replaced.
 */
export const MAX_DIFF_TOKENS = 20_000;

/** Lines, each with its newline (the last may have none). */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Words, runs of spaces, single Chinese or Japanese characters and single marks: joined, the text again. */
export function splitWords(text: string): string[] {
  return text.match(/\s+|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}_]+|[\s\S]/gu) ?? [];
}

/**
 * The shortest edit script from `a` to `b` (Myers, O((N+M)·D)), as runs of equal, deleted and
 * inserted tokens. Common ends are trimmed first; a very different pair, or a middle longer than
 * MAX_DIFF_TOKENS, is one delete and one insert.
 */
export function diffTokens(a: readonly string[], b: readonly string[]): Array<{ op: DiffOp; tokens: string[] }> {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const out: Array<{ op: DiffOp; tokens: string[] }> = [];
  const push = (op: DiffOp, token: string) => {
    const last = out[out.length - 1];
    if (last?.op === op) last.tokens.push(token);
    else out.push({ op, tokens: [token] });
  };
  for (let index = 0; index < start; index++) push('equal', a[index]!);
  if (endA - start + (endB - start) > MAX_DIFF_TOKENS) {
    // Too much to compare finely: the middle was replaced.
    for (let index = start; index < endA; index++) push('delete', a[index]!);
    for (let index = start; index < endB; index++) push('insert', b[index]!);
  } else {
    for (const [op, token] of myers(a.slice(start, endA), b.slice(start, endB))) push(op, token);
  }
  for (let index = endA; index < a.length; index++) push('equal', a[index]!);
  return out;
}

function myers(a: readonly string[], b: readonly string[]): Array<[DiffOp, string]> {
  const n = a.length;
  const m = b.length;
  if (!n) return b.map((token) => ['insert', token]);
  if (!m) return a.map((token) => ['delete', token]);
  const max = Math.min(n + m, MAX_EDITS);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for k in [-d-1, d+1] as it was before step d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b);
    }
  }
  // Too different to be worth a fine diff.
  return [
    ...a.map((token): [DiffOp, string] => ['delete', token]),
    ...b.map((token): [DiffOp, string] => ['insert', token]),
  ];
}

function backtrack(trace: Int32Array[], a: readonly string[], b: readonly string[]): Array<[DiffOp, string]> {
  const ops: Array<[DiffOp, string]> = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snapshot = trace[d]!;
    const at = (k: number) => snapshot[k + d + 1]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push(['equal', a[x - 1]!]);
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) {
        ops.push(['insert', b[y - 1]!]);
        y--;
      } else {
        ops.push(['delete', a[x - 1]!]);
        x--;
      }
    }
  }
  return ops.reverse();
}

/** Long unchanged text keeps its two ends. */
function shorten(text: string): string {
  if (text.length <= MAX_EQUAL) return text;
  const keep = Math.floor((MAX_EQUAL - 3) / 2);
  return `${text.slice(0, keep)} … ${text.slice(-keep)}`;
}

function pushPart(parts: DiffPart[], op: DiffOp, text: string) {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last?.op === op) last.text += text;
  else parts.push({ op, text });
}

/** Two texts as hunks of changed lines (or words) with a little context around each. */
export function diffText(
  from: string,
  to: string,
  mode: 'line' | 'word',
): { hunks: Hunk[]; added: number; removed: number; truncated: boolean } {
  const runs = diffTokens(splitLines(from), splitLines(to));
  // Lines of each run, with where they start in each version.
  type Run = { op: DiffOp; lines: string[]; fromLine: number; toLine: number };
  const lined: Run[] = [];
  let fromLine = 1;
  let toLine = 1;
  for (const run of runs) {
    lined.push({ op: run.op, lines: run.tokens, fromLine, toLine });
    if (run.op !== 'insert') fromLine += run.tokens.length;
    if (run.op !== 'delete') toLine += run.tokens.length;
  }

  let added = 0;
  let removed = 0;
  const hunks: Hunk[] = [];
  let size = 0;
  let truncated = false;
  let index = 0;
  while (index < lined.length) {
    if (lined[index]!.op === 'equal') {
      index++;
      continue;
    }
    // A hunk: changes, joined while the unchanged stretch between them is short.
    let end = index;
    while (end + 1 < lined.length) {
      const next = lined[end + 1]!;
      if (next.op !== 'equal') end++;
      else if (end + 2 < lined.length && next.lines.length <= CONTEXT_LINES * 2) end += 2;
      else break;
    }
    const before = lined[index - 1]?.op === 'equal' ? lined[index - 1]!.lines.slice(-CONTEXT_LINES) : [];
    const after = lined[end + 1]?.op === 'equal' ? lined[end + 1]!.lines.slice(0, CONTEXT_LINES) : [];
    const parts: DiffPart[] = [];
    pushPart(parts, 'equal', shorten(before.join('')));
    let deleted: string[] = [];
    let inserted: string[] = [];
    const flush = () => {
      if (!deleted.length && !inserted.length) return;
      if (mode === 'word') {
        const words = diffTokens(splitWords(deleted.join('')), splitWords(inserted.join('')));
        for (const run of words) {
          const text = run.tokens.join('');
          const counted = run.tokens.filter((token) => token.trim()).length;
          if (run.op === 'insert') added += counted;
          if (run.op === 'delete') removed += counted;
          pushPart(parts, run.op, run.op === 'equal' ? shorten(text) : text);
        }
      } else {
        removed += deleted.length;
        added += inserted.length;
        pushPart(parts, 'delete', deleted.join(''));
        pushPart(parts, 'insert', inserted.join(''));
      }
      deleted = [];
      inserted = [];
    };
    for (let at = index; at <= end; at++) {
      const run = lined[at]!;
      // Runs can hold a whole doc's lines: appended one by one, never spread into a call.
      if (run.op === 'delete') for (const line of run.lines) deleted.push(line);
      else if (run.op === 'insert') for (const line of run.lines) inserted.push(line);
      else {
        flush();
        pushPart(parts, 'equal', shorten(run.lines.join('')));
      }
    }
    flush();
    pushPart(parts, 'equal', shorten(after.join('')));
    const first = lined[index]!;
    const hunk = {
      from_line: first.fromLine - before.length,
      to_line: first.toLine - before.length,
      parts,
    };
    const hunkSize = parts.reduce((sum, part) => sum + part.text.length, 0);
    if (hunks.length >= MAX_HUNKS || size + hunkSize > MAX_TEXT) truncated = true;
    else {
      hunks.push(hunk);
      size += hunkSize;
    }
    index = end + 1;
  }
  return { hunks, added, removed, truncated };
}
