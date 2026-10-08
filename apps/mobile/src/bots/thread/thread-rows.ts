/**
 * The thread's rows: the vendored transcript (`buildTranscript` — speakers,
 * hand-offs, events, cards, live segments, sends in flight) plus what only the
 * phone draws around it (spec §2.5.3 b):
 *
 *  - `top` (more history above: the loader) or `intro` (the thread's start);
 *  - `time` — a Messages-style separator before a row written ≥ 60 min after
 *    the one before it, or on another calendar day (and before the first
 *    dated row). Live rows (segments, sends, cards not persisted yet) are
 *    dated "now", so a reply after a long pause gets its separator at once
 *    and keeps it when the persisted copy replaces the live one;
 *  - `starters` — while the Bot's greeting is still the last word and someone
 *    can reply (they only prefill the composer);
 *  - `tail` — the run's footer (static "Working…", a failed run's reason).
 *
 * And what it leaves out: lines that only repeat a card's own receipt right
 * above them — `created` (the card already reads "Created {name}"; the
 * `joined` line that follows says it is here) and `task_started` (the card
 * reads "Started · {title}", the task dock tracks it, its report closes it).
 * Both are only ever written when the member accepts such a card.
 *
 * Pure (tested in ./thread-rows.test.ts); never edits the vendored module.
 */

import type { TranscriptItem } from '../vendor/transcript';

export type ThreadRow =
  | TranscriptItem
  | { key: string; kind: 'time'; at: string }
  | { key: string; kind: 'intro' }
  | { key: string; kind: 'starters'; botId: string }
  | { key: string; kind: 'top' }
  | { key: string; kind: 'tail' };

/** Event lines a card's receipt already says (see the header). */
const ECHOES = new Set(['created', 'task_started']);

function isEcho(item: TranscriptItem): boolean {
  return item.kind === 'event' && !!item.event && ECHOES.has(item.event.kind);
}

/** A gap at least this long gets a time separator. */
export const SEPARATOR_GAP_MS = 60 * 60_000;

/** When a transcript item was written (ms); null = it rides with the row before it (a hand-off strip). */
function writtenAt(item: TranscriptItem, now: number): number | null {
  switch (item.kind) {
    case 'user':
    case 'bot':
    case 'event': {
      const at = Date.parse(item.message.created_at);
      return Number.isFinite(at) ? at : null;
    }
    case 'request': {
      if (!item.message) return now;
      const at = Date.parse(item.message.created_at);
      return Number.isFinite(at) ? at : null;
    }
    case 'segment':
    case 'pending':
      return now;
    case 'handoff':
      return null;
  }
}

function dayOf(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Same local calendar day. */
export function sameDay(a: number, b: number): boolean {
  return dayOf(a) === dayOf(b);
}

/** Which form a separator's day part takes: today, yesterday, a date this year, a date with its year. */
export function separatorDay(at: number, now: number): 'today' | 'yesterday' | 'date' | 'dateYear' {
  const days = Math.round((dayOf(now) - dayOf(at)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  return new Date(at).getFullYear() === new Date(now).getFullYear() ? 'date' : 'dateYear';
}

export function threadRows(
  items: TranscriptItem[],
  o: {
    hasMore: boolean;
    /** Someone here can still reply (no starters in a read-only thread). */
    replyable: boolean;
    /** Part of the frozen signature; rows carry raw timestamps and are formatted at render time. */
    locale: string;
    /** "Now" for live rows (default: the clock). */
    now?: number;
  },
): ThreadRow[] {
  const now = o.now ?? Date.now();
  const rows: ThreadRow[] = [o.hasMore ? { key: 'top', kind: 'top' } : { key: 'intro', kind: 'intro' }];
  let last: number | null = null;
  for (const item of items) {
    if (isEcho(item)) continue;
    const at = writtenAt(item, now);
    if (at != null) {
      if (last == null || at - last >= SEPARATOR_GAP_MS || !sameDay(at, last)) {
        rows.push({ key: `time:${item.key}`, kind: 'time', at: new Date(at).toISOString() });
      }
      last = Math.max(last ?? at, at);
    }
    rows.push(item);
  }
  const final = items[items.length - 1];
  if (o.replyable && final?.kind === 'bot' && final.message.bot_event?.kind === 'greeting') {
    rows.push({ key: 'starters', kind: 'starters', botId: final.botId ?? final.message.bot_event.bot_id });
  }
  rows.push({ key: 'tail', kind: 'tail' });
  return rows;
}
