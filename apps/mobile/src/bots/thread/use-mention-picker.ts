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
 * The pure pieces live in ./mention-query.ts (tested in the root vitest); the
 * hook only holds the caret.
 */

import { useCallback, useMemo, useState } from 'react';
import { applyMention, mentionCandidates, mentionQuery, type MentionMember } from './mention-query';

export type { MentionMember };

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
