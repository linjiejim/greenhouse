/**
 * The `@` mention picker's pure pieces (./use-mention-picker.ts holds the
 * caret): which token the caret sits in, who matches it, and what a pick
 * writes. React-free on purpose — the root vitest runs ./mention-query.test.ts
 * in CI, where apps/mobile's own install (react, react-native) is absent.
 */

import { mentionToken } from '../vendor/mentions';

/** A Bot that can be addressed here. */
export interface MentionMember {
  id: string;
  name: string;
  role: string;
}

/** The token before the caret: `@` after the start / a space / an opener, then ≤ 24 non-space characters. */
const TOKEN = /(^|[\s(（[【"'“‘])@([^\s@]{0,24})$/;

/** The `@` query the caret sits in (`start` = the index of its `@`), or null. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const head = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = TOKEN.exec(head);
  if (!match) return null;
  const query = match[2];
  return { query, start: head.length - query.length - 1 };
}

/** Members whose name or role contains the query (case-insensitive), in the order given. */
export function mentionCandidates<T extends MentionMember>(members: readonly T[], query: string): T[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...members];
  return members.filter(
    (member) => member.name.toLocaleLowerCase().includes(q) || member.role.toLocaleLowerCase().includes(q),
  );
}

/**
 * Replace the token `text[start, caret)` with "@Name " (one space after it,
 * even when the member had typed one already); the caret lands after it.
 */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  name: string,
): { text: string; caret: number } {
  const token = mentionToken(name);
  const before = text.slice(0, start);
  const after = text.slice(caret).replace(/^ /, '');
  return { text: before + token + after, caret: before.length + token.length };
}
