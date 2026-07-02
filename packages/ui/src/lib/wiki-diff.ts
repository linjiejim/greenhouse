/**
 * Diff algorithms for wiki content comparison.
 *
 * Provides line-level and word-level diff with LCS (Longest Common Subsequence).
 * Used by wiki changelog diff views and admin profile inline diff display.
 */

// ─── Types ───────────────────────────────────────────────

export interface WordSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  type: 'add' | 'remove' | 'same';
  text: string;
  words?: WordSegment[];
}

export interface WordDiffResult {
  before: WordSegment[];
  after: WordSegment[];
}

// ─── Line Diff with Word-Level Detail ────────────────────

/**
 * Compute line-level diff with word-level detail for changed line pairs.
 * Consecutive remove+add lines are paired for word-level comparison.
 *
 * @param maxLines  Lines beyond this threshold fall back to simple add/remove (default 500)
 */
export function computeLineDiffWithWords(before: string, after: string, maxLines = 500): DiffLine[] {
  const aLines = before.split('\n');
  const bLines = after.split('\n');

  if (aLines.length > maxLines || bLines.length > maxLines) {
    const result: DiffLine[] = [];
    for (const l of aLines) result.push({ type: 'remove', text: l });
    for (const l of bLines) result.push({ type: 'add', text: l });
    return result;
  }

  // LCS for line-level diff
  const m = aLines.length;
  const n = bLines.length;
  const dp = buildLcsTable(aLines, bLines, m, n);

  // Backtrack to produce operations
  const ops: Array<{ type: 'add' | 'remove' | 'same'; aIdx?: number; bIdx?: number }> = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aLines[i - 1] === bLines[j - 1]) {
      ops.push({ type: 'same', aIdx: i - 1, bIdx: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: 'add', bIdx: j - 1 });
      j--;
    } else {
      ops.push({ type: 'remove', aIdx: i - 1 });
      i--;
    }
  }
  ops.reverse();

  // Group consecutive remove+add pairs for word-level diff
  const result: DiffLine[] = [];
  let idx = 0;
  while (idx < ops.length) {
    const op = ops[idx];
    if (op.type === 'same') {
      result.push({ type: 'same', text: aLines[op.aIdx!] });
      idx++;
    } else if (op.type === 'remove') {
      const removes: number[] = [];
      while (idx < ops.length && ops[idx].type === 'remove') {
        removes.push(ops[idx].aIdx!);
        idx++;
      }
      const adds: number[] = [];
      while (idx < ops.length && ops[idx].type === 'add') {
        adds.push(ops[idx].bIdx!);
        idx++;
      }
      const maxPairs = Math.min(removes.length, adds.length);
      for (let p = 0; p < maxPairs; p++) {
        const wordDiff = computeWordDiff(aLines[removes[p]], bLines[adds[p]]);
        result.push({ type: 'remove', text: aLines[removes[p]], words: wordDiff.before });
        result.push({ type: 'add', text: bLines[adds[p]], words: wordDiff.after });
      }
      for (let p = maxPairs; p < removes.length; p++) {
        result.push({ type: 'remove', text: aLines[removes[p]] });
      }
      for (let p = maxPairs; p < adds.length; p++) {
        result.push({ type: 'add', text: bLines[adds[p]] });
      }
    } else {
      result.push({ type: 'add', text: bLines[op.bIdx!] });
      idx++;
    }
  }

  return result;
}

// ─── Word-Level Diff ─────────────────────────────────────

/**
 * Compute word-level diff between two lines.
 * Returns before/after arrays with changed markers.
 *
 * @param maxWords  Tokens beyond this threshold mark entire line as changed (default 100)
 */
export function computeWordDiff(aLine: string, bLine: string, maxWords = 100): WordDiffResult {
  const aWords = tokenize(aLine);
  const bWords = tokenize(bLine);

  const m = aWords.length;
  const n = bWords.length;

  if (m > maxWords || n > maxWords) {
    return {
      before: [{ text: aLine, changed: true }],
      after: [{ text: bLine, changed: true }],
    };
  }

  const dp = buildLcsTable(aWords, bWords, m, n);

  const bStack: WordSegment[] = [];
  const aStack: WordSegment[] = [];
  let i = m,
    j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && aWords[i - 1] === bWords[j - 1]) {
      bStack.push({ text: aWords[i - 1], changed: false });
      aStack.push({ text: bWords[j - 1], changed: false });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      aStack.push({ text: bWords[j - 1], changed: true });
      j--;
    } else {
      bStack.push({ text: aWords[i - 1], changed: true });
      i--;
    }
  }

  bStack.reverse();
  aStack.reverse();

  return { before: bStack, after: aStack };
}

// ─── Internals ───────────────────────────────────────────

/** Tokenize a string into word and whitespace chunks */
export function tokenize(str: string): string[] {
  return str.match(/(\S+|\s+)/g) || [];
}

/** Build an LCS dynamic programming table */
function buildLcsTable(a: string[], b: string[], m: number, n: number): number[][] {
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return dp;
}
