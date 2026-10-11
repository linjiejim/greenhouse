/**
 * `@` mentions while typing — the pure pieces every composer shares (the Bots
 * thread's mention strip, src/bots/thread/use-mention-picker.ts; the Tables /
 * app record comment strip, src/ui/comment-thread.tsx). React-free on purpose:
 * the root vitest runs ./mentions.test.ts in CI, where apps/mobile's own install
 * (react, react-native) is absent.
 *
 *  - `mentionQuery`: which `@` token the caret sits in;
 *  - `mentionCandidates`: who matches it (name or role, case-insensitive);
 *  - `applyMention`: replace the token with what the caller writes for a pick
 *    (the Bots thread: the vendored `mentionToken` "@Name "; comments: the same
 *    visible "@Name " — turned into `[@Name](user:<id>)` links on send by
 *    `encodeMentions`, the wire format in ../shared/mentions.ts).
 */

import { findMentionLinks, mentionMarkdown } from '../shared/mentions';

/** Someone who can be addressed. */
export interface MentionMember {
  id: string;
  name: string;
  /** Matched too (a Bot's role); people have none. */
  role?: string;
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
    (member) => member.name.toLocaleLowerCase().includes(q) || (member.role ?? '').toLocaleLowerCase().includes(q),
  );
}

/**
 * Replace the token `text[start, caret)` with `token` (one space after it, even
 * when the member had typed one already); the caret lands after it.
 */
export function applyMention(
  text: string,
  start: number,
  caret: number,
  token: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(caret).replace(/^ /, '');
  return { text: before + token + after, caret: before.length + token.length };
}

/** What a comment composer writes for a picked person: the visible "@Name ". */
export function personToken(name: string): string {
  return `@${name} `;
}

/** Characters that end a typed `@Name` (ASCII + CJK punctuation). */
const NAME_END = /^$|^[\s,.;:!?，。；：！？、)）\]】"'”’]/;

/**
 * A comment as sent: every "@Name" of a person picked from the strip (and still
 * in the text) becomes the `[@Name](user:<id>)` link the server notifies;
 * anything else typed with an "@" stays plain text. Longest names first, so
 * "Ann" never shadows "Ann Lee".
 */
export function encodeMentions(text: string, picked: readonly MentionMember[]): string {
  const people = [...new Map(picked.map((person) => [person.id, person])).values()].sort(
    (a, b) => b.name.length - a.name.length,
  );
  let out = '';
  let index = 0;
  while (index < text.length) {
    const at = text.indexOf('@', index);
    if (at < 0) break;
    const hit = people.find(
      (person) => text.startsWith(person.name, at + 1) && NAME_END.test(text.slice(at + 1 + person.name.length)),
    );
    if (!hit) {
      out += text.slice(index, at + 1);
      index = at + 1;
      continue;
    }
    out += text.slice(index, at) + mentionMarkdown(hit.name, hit.id);
    index = at + 1 + hit.name.length;
  }
  return out + text.slice(index);
}

/** A stored comment for the Markdown renderer: mention links read as bold "@Name" (they are not web links). */
export function mentionsForDisplay(markdown: string): string {
  let out = '';
  let index = 0;
  for (const link of findMentionLinks(markdown)) {
    out += `${markdown.slice(index, link.index)}**@${link.name}**`;
    index = link.index + link.text.length;
  }
  return out + markdown.slice(index);
}
