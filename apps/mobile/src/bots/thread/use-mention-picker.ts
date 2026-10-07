/**
 * `@` mentions while typing in a Bots thread (spec §2.5.3 i): the composer
 * reports its caret (`onSelectionChange`), the token right before it is read
 * as a query — `@` at the start or after a space / opening bracket / quote,
 * then up to 24 non-space characters (CJK names included) — and the members
 * whose name or role contains it are offered in the mention strip
 * (./mention-strip.tsx). Picking one replaces the token with the vendored
 * `mentionToken` ("@Name ") and puts the caret after it. No match → no strip:
 * the picker never swallows a send. At send time the vendored
 * `parseMentions` turns what was typed into ids (it also catches a name typed
 * by hand), so the strip is a shortcut, not the source of truth.
 *
 * The pure pieces are exported for ./use-mention-picker.test.ts; the hook only
 * holds the caret.
 */

import { useCallback, useMemo, useState } from 'react';
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

export interface MentionPicker<T extends MentionMember> {
  /** Show the strip: the caret is in an `@` token and someone matches. */
  open: boolean;
  candidates: T[];
  /** Composer `onSelectionChange`. */
  onSelectionChange(sel: { start: number; end: number }): void;
  /** The text with `member` mentioned at the caret, and where the caret goes (null: no token any more). */
  pick(member: T): { text: string; caret: number } | null;
}

export function useMentionPicker<T extends MentionMember>({
  text,
  members,
  enabled,
}: {
  text: string;
  members: readonly T[];
  /** Off where there is nothing to address (read-only). */
  enabled: boolean;
}): MentionPicker<T> {
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  // A collapsed caret only — a range selection is editing, not mentioning.
  const caret = selection && selection.start === selection.end ? selection.start : null;
  const query = enabled && caret != null ? mentionQuery(text, caret) : null;
  const q = query?.query ?? null;
  const candidates = useMemo(() => (q == null ? [] : mentionCandidates(members, q)), [members, q]);
  const start = query?.start ?? -1;
  const pick = useCallback(
    (member: T) => (caret == null || start < 0 ? null : applyMention(text, start, caret, member.name)),
    [text, start, caret],
  );
  return { open: candidates.length > 0, candidates, onSelectionChange: setSelection, pick };
}
