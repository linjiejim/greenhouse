/**
 * Words for full-text search in Chinese and English, on plain PostgreSQL (`simple` config, no
 * extensions). PostgreSQL does not split Chinese into words, so the application does: runs of
 * Chinese text go through jieba, everything else splits into letter-and-digit words. Stored
 * tokens (`searchTokens`) and queries (`searchQuery`) go through the same function, so they line
 * up; the index side also keeps the shorter words inside long ones (每周五 → 每周, 周五).
 */

import { createRequire } from 'node:module';
import type { Jieba } from '@node-rs/jieba';

const require = createRequire(import.meta.url);
let jieba: Jieba | null = null;

/** The native module and its dictionary load on first use, once per process, not on import. */
function segmenter(): Jieba {
  if (!jieba) {
    const native = require('@node-rs/jieba') as typeof import('@node-rs/jieba');
    const { dict } = require('@node-rs/jieba/dict.js') as typeof import('@node-rs/jieba/dict.js');
    jieba = native.Jieba.withDict(dict);
  }
  return jieba;
}

/** Chinese and Japanese characters: segmented by jieba rather than split on spaces. */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/u;
const RUNS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+/gu;
const WORDS = /[\p{L}\p{N}]+/gu;
const NOT_WORD = /[^\p{L}\p{N}]/gu;
/** Text beyond this is not indexed: it bounds the work per save and the size of the vector. */
export const MAX_INDEXED_CHARS = 100_000;

/**
 * The words of a text, lower-cased. `index` adds the shorter words jieba finds inside long
 * Chinese words, so a search for a part of one still matches.
 */
export function segment(text: string, mode: 'index' | 'query' = 'index'): string[] {
  const words: string[] = [];
  for (const run of text.normalize('NFKC').toLowerCase().match(RUNS) ?? []) {
    if (CJK.test(run)) {
      const pieces = mode === 'index' ? segmenter().cutForSearch(run, true) : segmenter().cut(run, true);
      for (const piece of pieces) {
        const word = piece.replace(NOT_WORD, '');
        if (word) words.push(word);
      }
    } else {
      words.push(...(run.match(WORDS) ?? []));
    }
  }
  return words;
}

/** What goes in a `search_a/b/c` column: the words of the parts, space separated. */
export function searchTokens(...parts: Array<string | null | undefined>): string {
  const text = parts.filter(Boolean).join('\n').slice(0, MAX_INDEXED_CHARS);
  return segment(text, 'index').join(' ');
}

/**
 * A `to_tsquery('simple', …)` string: every word as a prefix, joined by AND (`&`, precise) or
 * OR (`|`, more results). Null when the query has no words.
 */
export function searchQuery(query: string, op: '&' | '|'): string | null {
  const words = [...new Set(segment(query, 'query'))];
  return words.length ? words.map((word) => `${word}:*`).join(` ${op} `) : null;
}

/** The query's words, for finding where a match is in the original text. */
export function queryWords(query: string): string[] {
  return [...new Set(segment(query, 'query'))];
}
