/**
 * The Bots thread screen's bookkeeping decisions (./thread-screen.tsx and its
 * bar, ./thread-header.tsx), kept pure so the root vitest can pin them — the
 * screen only wires them to refs, effects and the engine's events:
 *
 *  - row geometry lives only as long as its row (`pruneRowGeometry`): a stale
 *    entry would anchor a new reply where an old one used to be;
 *  - what a run starting / settling does to a pending anchor
 *    (`expectOnRunStarted` / `expectOnRunSettled`);
 *  - an earlier page in flight (`prependStep`): growth below it (a reply still
 *    streaming) is not part of the page;
 *  - a deep-linked card (`deepLinkStep`, `showsFreshPage`): the in-memory copy
 *    a thread opens with may predate the card, so only the network's page may
 *    say it isn't there;
 *  - the ☰ badge as shown and as heard (`menuBadge`, `drawerButtonLabel`).
 */

/* ---------- row geometry ---------- */

/**
 * Drop the geometry of rows that are no longer mounted: only a freshly
 * mounted row's own layout may place an anchor on it (a key that came back as
 * another row — the vendored transcript keys every run's first reply
 * `segment:0` — must be measured afresh).
 */
export function pruneRowGeometry<V>(geometry: Map<string, V>, mounted: Iterable<string>): void {
  if (geometry.size === 0) return;
  const keep = new Set(mounted);
  for (const key of [...geometry.keys()]) if (!keep.has(key)) geometry.delete(key);
}

/* ---------- anchoring a turn ---------- */

/**
 * The row the next anchor waits for: a send's bubble (`pending`, keyboard
 * down) or the first reply of a run the server started by itself (`segment`,
 * tagged with that run).
 */
export type ExpectAnchor = { kind: 'pending' } | { kind: 'segment'; runKey: string } | null;

/**
 * A run started. One nobody here sent is anchored (its first reply slides
 * under the bar, the rest unfolds below — nothing is followed) when the member
 * is at the end, keyboard up or not: a reply that isn't anchored is never
 * chased either, it lights "New messages ↓". Otherwise a `segment` left over
 * from an earlier run (one that never showed a reply) is dropped — it would
 * yank the scroll to some later, unrelated reply. A send's `pending` stays.
 */
export function expectOnRunStarted(
  current: ExpectAnchor,
  run: { runKey: string; byMe: boolean },
  view: { endVisible: boolean },
): ExpectAnchor {
  if (!run.byMe && view.endVisible) return { kind: 'segment', runKey: run.runKey };
  return current?.kind === 'segment' ? null : current;
}

/** A run settled: if it never showed a reply, nothing is waiting for one any more. */
export function expectOnRunSettled(current: ExpectAnchor, runKey: string): ExpectAnchor {
  return current?.kind === 'segment' && current.runKey === runKey ? null : current;
}

/* ---------- earlier pages ---------- */

/** An earlier page in flight: the content height and the first message when it was asked for. */
export interface PrependHold {
  height: number;
  first: string | null;
}

/**
 * The content changed size while an earlier page was in flight. The page has
 * landed once the first message is another one: `delta` is what it added
 * above. Before that, any change is growth elsewhere (a reply streaming, a
 * tool row) and moves the baseline with it, so it is never counted as page.
 */
export function prependStep(
  hold: PrependHold,
  first: string | null,
  height: number,
): { landed: true; delta: number } | { landed: false; hold: PrependHold } {
  if (first !== hold.first) return { landed: true, delta: height - hold.height };
  return { landed: false, hold: hold.height === height ? hold : { ...hold, height } };
}

/* ---------- a deep-linked card ---------- */

/**
 * Whether the snapshot is past the copy the thread opened with: a page from
 * the network replaced its conversation (every page brings a new object), or
 * the attempt failed. `openedWith` is the cached conversation the engine
 * shows first — null when it had none, so the first page is already fresh.
 */
export function showsFreshPage(o: {
  conversation: object | null;
  openedWith: object | null;
  refreshFailed: boolean;
}): boolean {
  return o.refreshFailed || (o.conversation !== null && o.conversation !== o.openedWith);
}

/**
 * `?request=<id>`: scroll to that card and highlight it once its row is in the
 * transcript; give up only when the newest page doesn't have it either. Until
 * then (loading, or only the cached copy on screen) keep waiting.
 */
export function deepLinkStep(o: { ready: boolean; found: boolean; fresh: boolean }): 'wait' | 'anchor' | 'give-up' {
  if (!o.ready) return 'wait';
  if (o.found) return 'anchor';
  return o.fresh ? 'give-up' : 'wait';
}

/* ---------- the ☰ badge ---------- */

/** The ☰ badge as drawn: '' for none, capped at "99+". */
export function menuBadge(count: number): string {
  return count > 99 ? '99+' : count > 0 ? String(count) : '';
}

/** What VoiceOver says for ☰ — the badge is drawn only, so its count goes into the label (as the chat's bar does). */
export function drawerButtonLabel(
  open: string,
  badge: string,
  phrases: { badge: (n: string) => string; separator: string },
): string {
  return badge ? [open, phrases.badge(badge)].join(phrases.separator) : open;
}

/** Rough one-line width of `text` in em: CJK, kana, hangul, full-width forms and emoji ≈ 1em, anything else ≈ 0.56em. */
export function textEm(text: string): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      code > 0xffff ||
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe4f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    em += wide ? 1 : 0.56;
  }
  return em;
}

/**
 * The composer's text width in its narrowest state — Stop showing beside Send —
 * measured on a 402pt-wide phone: the field is the window minus 128pt (+, Send,
 * margins), minus 52pt (Stop), minus 32pt of padding.
 */
export function composerTextWidth(windowWidth: number): number {
  return windowWidth - 212;
}

/**
 * Whether a composer hint ("Message {name}", the group's @ hint) stays on one line (else the plain hint).
 * Judged at the narrowest state, so the hint never changes when a run starts;
 * `fontPt` is the field's size after Dynamic Type.
 */
export function hintFits(text: string, windowWidth: number, fontPt: number): boolean {
  return textEm(text) * fontPt <= composerTextWidth(windowWidth);
}
