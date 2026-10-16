/**
 * What the composer offers while typing, React-free (./picker.test.ts):
 *
 * - `@` (after the start, a space or an opening bracket or quote, then up to 30 characters):
 *   in a room, the people and my own Agents there; in a new chat, my Agents (picking one
 *   switches who answers).
 * - `/` at the very start of the message: the skills this conversation's Agent can run.
 *
 * A pick replaces the token: a mention becomes "@Name " (and counts as a mention only while that
 * text is still in the message when it is sent — the web's rule); a skill is chosen and its
 * token removed.
 */

/** Someone `@` can name: `handle` is what goes into `mentions` (`main`, `agent:<id>`, a member id). */
export interface MentionCandidate {
  handle: string;
  name: string;
  hint?: string;
}

const MENTION = /(^|[\s(（[【"'“‘])@([^\s@]{0,30})$/;
const SLASH = /^\/([^\s/]{0,40})$/;

/** The `@` token the caret sits in (`start` = the index of its `@`), or null. */
export function mentionQuery(text: string, caret: number): { query: string; start: number } | null {
  const head = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const match = MENTION.exec(head);
  if (!match) return null;
  const query = match[2]!;
  return { query, start: head.length - query.length - 1 };
}

/** The `/` token at the start of the message, up to the caret, or null. */
export function slashQuery(text: string, caret: number): string | null {
  const match = SLASH.exec(text.slice(0, Math.max(0, Math.min(caret, text.length))));
  return match ? match[1]! : null;
}

/** Entries whose name (or hint) contains the query, case-insensitive, in the order given. */
export function matching<T extends { name: string; hint?: string }>(list: readonly T[], query: string, max = 8): T[] {
  const q = query.trim().toLocaleLowerCase();
  const hits = q
    ? list.filter((item) => item.name.toLocaleLowerCase().includes(q) || !!item.hint?.toLocaleLowerCase().includes(q))
    : [...list];
  return hits.slice(0, max);
}

/** The text with the token `text[start, caret)` replaced by "@Name " and where the caret goes. */
export function applyMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const token = `@${name} `;
  const before = text.slice(0, start);
  const after = text.slice(caret).replace(/^ /, '');
  return { text: before + token + after, caret: before.length + token.length };
}

/** The text with the `@` token removed (a new chat's Agent switch leaves no trace in the text). */
export function dropToken(text: string, start: number, caret: number): string {
  return text.slice(0, start) + text.slice(caret).replace(/^ /, '');
}

/** The text without its leading `/token` (a skill was chosen). */
export function dropSlash(text: string): string {
  return text.replace(/^\/\S*\s?/, '');
}

/** The handles of picked candidates whose "@Name" is still in the text, without duplicates. */
export function namedMentions(text: string, picked: readonly MentionCandidate[]): string[] {
  const seen = new Set<string>();
  return picked
    .filter((candidate) => text.includes(`@${candidate.name}`))
    .map((candidate) => candidate.handle)
    .filter((handle) => (seen.has(handle) ? false : (seen.add(handle), true)));
}
