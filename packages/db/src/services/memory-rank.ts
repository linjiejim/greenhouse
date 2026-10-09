/**
 * Memory recall ranking — pure, no LLM, no extra columns.
 *
 * `recall` used to be `ILIKE '%<whole query>%'` over title + content: a
 * multi-word query only matched a memory containing that exact substring, so
 * "CRM 报表 偏好" found nothing although every word was in a memory. Each user
 * holds tens to a few hundred memories (memory-v2 D3 — the reason pgvector was
 * rejected), so ranking happens in the app over that candidate set, borrowing
 * the shape of Octop Memory's recall pipeline (spec 20261009 D7):
 *
 *   tokenise (jieba + CJK bigrams) → BM25-style lexical score → weighted
 *   rerank (lexical 0.55, pinned 0.15, recency 0.15 with a 30-day half-life,
 *   status 0.15) → near-duplicate removal (Jaccard ≥ 0.85) → count + character
 *   budget.
 *
 * A memory with no lexical overlap is never returned — recall still means
 * "matches what was asked", only no longer "matches it verbatim".
 */

import { segmentForFts } from './fts.js';

export interface RankableMemory {
  id: number;
  title: string;
  content: string;
  pinned: boolean;
  status: string;
  last_used_at: string | null;
  created_at: string;
}

export interface MemoryRankOptions {
  /** Most results (default 20). */
  limit?: number;
  /** Stop once the returned bodies pass this many characters; the first result always fits (default 8000). */
  budgetChars?: number;
  /** Clock for recency (tests). */
  now?: number;
}

export const MEMORY_RECALL_LIMIT = 20;
export const MEMORY_RECALL_BUDGET_CHARS = 8000;
const RECENCY_HALF_LIFE_DAYS = 30;
const DUPLICATE_JACCARD = 0.85;

const WEIGHTS = { lexical: 0.55, pinned: 0.15, recency: 0.15, status: 0.15 } as const;
const STATUS_PRIOR: Record<string, number> = { active: 1, dormant: 0.5, archived: 0.3 };

/** Words that match nearly everything and would only add noise to a small corpus. */
const STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'for',
  'and',
  'or',
  'with',
  'is',
  'are',
  'be',
  'it',
  'as',
  'that',
  'this',
  'from',
  'user',
  'users',
  '的',
  '了',
  '是',
  '在',
  '和',
  '与',
  '及',
  '或',
  '也',
  '都',
  '就',
  '要',
  '把',
  '被',
  '这',
  '那',
  '我',
  '你',
  '他',
  '她',
  '它',
]);

const CJK = /[㐀-鿿豈-﫿]/;
const CJK_RUN = /[㐀-鿿豈-﫿]{2,}/g;

/** Index terms of a text: jieba words (minus stopwords and lone CJK characters) plus CJK bigrams. */
export function memoryTerms(text: string): Set<string> {
  const terms = new Set<string>();
  for (const token of segmentForFts(text).split(/\s+/)) {
    if (!token || STOPWORDS.has(token)) continue;
    // A lone CJK character is too ambiguous on its own; the bigrams below
    // carry its signal in context.
    if (token.length === 1 && CJK.test(token)) continue;
    terms.add(token);
  }
  // Bigrams catch the overlap jieba's segmentation can miss ("季度报告" vs "季报").
  for (const run of text.match(CJK_RUN) ?? []) {
    for (let i = 0; i < run.length - 1; i++) terms.add(run.slice(i, i + 2));
  }
  return terms;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let shared = 0;
  for (const term of a) if (b.has(term)) shared++;
  return shared / (a.size + b.size - shared);
}

function recencyScore(row: RankableMemory, now: number): number {
  const stamp = Date.parse(row.last_used_at ?? row.created_at);
  if (!Number.isFinite(stamp)) return 0;
  const days = Math.max(0, (now - stamp) / 86_400_000);
  return Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS);
}

/** Rank candidate memories for a recall query. Pure; returns a new array. */
export function rankMemories<T extends RankableMemory>(
  rows: readonly T[],
  query: string,
  opts: MemoryRankOptions = {},
): T[] {
  const queryTerms = [...memoryTerms(query)];
  const needle = query.trim().toLowerCase();
  if (queryTerms.length === 0 && !needle) return [];

  const docs = rows.map((row) => ({
    row,
    title: memoryTerms(row.title),
    body: memoryTerms(row.content),
    all: memoryTerms(`${row.title}\n${row.content}`),
    text: `${row.title}\n${row.content}`.toLowerCase(),
  }));

  // BM25-style idf over this candidate set: a term in every memory says little.
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const term of queryTerms) {
    const df = docs.reduce((count, doc) => count + (doc.all.has(term) ? 1 : 0), 0);
    idf.set(term, Math.log(1 + (n - df + 0.5) / (df + 0.5)));
  }

  const scored = docs
    .map((doc) => {
      let lexical = 0;
      for (const term of queryTerms) {
        // A title hit is worth twice a body hit: the title is the memory's own index line.
        const weight = (doc.title.has(term) ? 2 : 0) + (doc.body.has(term) ? 1 : 0);
        lexical += weight * (idf.get(term) ?? 0);
      }
      // The old contract still wins: the exact phrase is the strongest signal.
      if (needle && doc.text.includes(needle)) lexical += 3;
      return { doc, lexical };
    })
    .filter((entry) => entry.lexical > 0);
  if (scored.length === 0) return [];

  const now = opts.now ?? Date.now();
  const maxLexical = Math.max(...scored.map((entry) => entry.lexical));
  const ranked = scored
    .map(({ doc, lexical }) => ({
      doc,
      score:
        WEIGHTS.lexical * (lexical / maxLexical) +
        WEIGHTS.pinned * (doc.row.pinned ? 1 : 0) +
        WEIGHTS.recency * recencyScore(doc.row, now) +
        WEIGHTS.status * (STATUS_PRIOR[doc.row.status] ?? 0),
    }))
    .sort((a, b) => b.score - a.score || b.doc.row.id - a.doc.row.id);

  // Near-duplicates (the weekly consolidation has not merged yet) cost budget
  // and say nothing new — keep the better-ranked one.
  const limit = opts.limit ?? MEMORY_RECALL_LIMIT;
  const budget = opts.budgetChars ?? MEMORY_RECALL_BUDGET_CHARS;
  const picked: typeof ranked = [];
  let used = 0;
  for (const entry of ranked) {
    if (picked.length >= limit) break;
    if (picked.some((kept) => jaccard(kept.doc.all, entry.doc.all) >= DUPLICATE_JACCARD)) continue;
    const size = entry.doc.row.title.length + entry.doc.row.content.length;
    if (picked.length > 0 && used + size > budget) continue;
    picked.push(entry);
    used += size;
  }
  return picked.map((entry) => entry.doc.row);
}
