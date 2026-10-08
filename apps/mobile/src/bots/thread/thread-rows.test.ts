/**
 * The thread's rows around the vendored transcript (./thread-rows.ts): time separators (≥ 60 min
 * or a new day, live rows dated "now"), the intro only at the thread's start, starters only under
 * a greeting that is still the last word in a thread someone can reply in. Times are built in
 * local time so day boundaries hold in any time zone.
 */

import { describe, expect, it } from 'vitest';
import type { BotMessage } from '../../shared/bots';
import { buildTranscript, type PendingSend, type TranscriptItem } from '../vendor/transcript';
import { SEPARATOR_GAP_MS, sameDay, separatorDay, threadRows, type ThreadRow } from './thread-rows';

const local = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();

let seq = 0;
function message(at: number, partial: Partial<BotMessage> = {}): BotMessage {
  seq += 1;
  return {
    id: `m${seq}`,
    role: 'assistant',
    content: 'x',
    bot_id: 'b_sage',
    bot_event: null,
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: iso(at),
    seq,
    ...partial,
  };
}
const user = (at: number) => message(at, { role: 'user', bot_id: null });

function items(messages: BotMessage[], extra: { pending?: PendingSend[] } = {}): TranscriptItem[] {
  return buildTranscript({ messages, conversationKind: 'direct', ownerBotId: 'b_sage', ...extra });
}

const kinds = (rows: ThreadRow[]) => rows.map((row) => row.kind);
const OPTS = { hasMore: false, replyable: true, locale: 'en-US' };

describe('threadRows', () => {
  it('intro at the start, the loader when there is more above; the tail always last', () => {
    const list = items([user(local(8, 9))]);
    expect(kinds(threadRows(list, OPTS))).toEqual(['intro', 'time', 'user', 'tail']);
    expect(kinds(threadRows(list, { ...OPTS, hasMore: true }))).toEqual(['top', 'time', 'user', 'tail']);
    expect(kinds(threadRows([], OPTS))).toEqual(['intro', 'tail']);
  });

  it('a separator before the first dated row, after a gap ≥ 60 min, and on a new day', () => {
    const rows = threadRows(
      items([
        user(local(8, 9, 0)),
        message(local(8, 9, 1)),
        user(local(8, 9, 59)), // 58 min after the reply: same block
        message(local(8, 11, 0)), // 61 min: new block
        user(local(9, 0, 5)), // after midnight, 65 min later: new block
        message(local(9, 0, 30)),
      ]),
      OPTS,
    );
    expect(kinds(rows)).toEqual(['intro', 'time', 'user', 'bot', 'user', 'time', 'bot', 'time', 'user', 'bot', 'tail']);
    const times = rows.filter((r): r is Extract<ThreadRow, { kind: 'time' }> => r.kind === 'time');
    expect(times.map((r) => r.at)).toEqual([iso(local(8, 9, 0)), iso(local(8, 11, 0)), iso(local(9, 0, 5))]);
    // keyed by the row it introduces
    expect(times[0].key).toBe(`time:${rows[2].key}`);
  });

  it('crossing midnight inside an hour still separates', () => {
    const rows = threadRows(items([user(local(8, 23, 50)), message(local(9, 0, 10))]), OPTS);
    expect(kinds(rows)).toEqual(['intro', 'time', 'user', 'time', 'bot', 'tail']);
  });

  it('exactly the gap separates', () => {
    const start = local(8, 9);
    const rows = threadRows(items([user(start), message(start + SEPARATOR_GAP_MS)]), OPTS);
    expect(kinds(rows).filter((k) => k === 'time')).toHaveLength(2);
  });

  it('live rows are dated now: a send after a long pause gets its separator', () => {
    const now = local(8, 15);
    const pending: PendingSend = { clientId: 'c1', content: 'Back', images: [], status: 'sending', afterSegment: 0 };
    const rows = threadRows(items([user(local(8, 9)), message(local(8, 9, 1))], { pending: [pending] }), {
      ...OPTS,
      now,
    });
    expect(kinds(rows)).toEqual(['intro', 'time', 'user', 'bot', 'time', 'pending', 'tail']);
    expect(rows[4]).toMatchObject({ kind: 'time', at: iso(now) });
    // …and none when the pause was short
    const soon = threadRows(items([user(local(8, 9))], { pending: [pending] }), { ...OPTS, now: local(8, 9, 10) });
    expect(kinds(soon)).toEqual(['intro', 'time', 'user', 'pending', 'tail']);
  });

  it('hand-off strips ride with the row before them', () => {
    const asked = message(local(8, 9), {
      pipeline: [
        {
          step: 0,
          tool: 'team',
          input: { action: 'ask', bot_id: 'b_fern', message: 'Draft it' },
          output: {},
          duration_ms: 1,
        },
      ],
    });
    const rows = threadRows(items([asked]), OPTS);
    expect(kinds(rows)).toEqual(['intro', 'time', 'bot', 'handoff', 'tail']);
  });

  it('starters only under a greeting that is still the last word, and only when someone can reply', () => {
    const greeting = message(local(8, 9), { bot_event: { kind: 'greeting', bot_id: 'b_sage' } });
    const rows = threadRows(items([greeting]), OPTS);
    expect(kinds(rows)).toEqual(['intro', 'time', 'bot', 'starters', 'tail']);
    expect(rows[3]).toEqual({ key: 'starters', kind: 'starters', botId: 'b_sage' });
    expect(kinds(threadRows(items([greeting]), { ...OPTS, replyable: false }))).not.toContain('starters');
    expect(kinds(threadRows(items([greeting, user(local(8, 9, 5))]), OPTS))).not.toContain('starters');
    expect(kinds(threadRows(items([message(local(8, 9))]), OPTS))).not.toContain('starters');
  });
});

describe('echo lines', () => {
  it('drops `created` and `task_started` (the card’s receipt says them), keeps `joined` and the rest', () => {
    const event = (at: number, bot_event: BotMessage['bot_event'], content: string) =>
      message(at, { role: 'system', bot_id: null, bot_event, content });
    const rows = threadRows(
      items([
        user(local(8, 9)),
        event(local(8, 9, 1), { kind: 'created', bot_id: 'b_new' }, 'Created the Bot “Nib”'),
        event(local(8, 9, 1), { kind: 'joined', bot_id: 'b_new', by: 'bot', by_bot_id: 'b_sage' }, 'Sage added Nib'),
        event(local(8, 9, 2), { kind: 'task_started', run_id: 'r1', bot_id: 'b_sage', title: 'T' }, 'Sage started “T”'),
        event(local(8, 9, 3), { kind: 'left', bot_id: 'b_new' }, 'Nib left the conversation'),
      ]),
      OPTS,
    );
    const events = rows.flatMap((row) => (row.kind === 'event' ? [row.event?.kind] : []));
    expect(events).toEqual(['joined', 'left']);
  });
});

describe('days', () => {
  it('sameDay is the local calendar day', () => {
    expect(sameDay(local(8, 0, 0), local(8, 23, 59))).toBe(true);
    expect(sameDay(local(8, 23, 59), local(9, 0, 0))).toBe(false);
  });

  it('separatorDay: today, yesterday, a date, a date with its year', () => {
    const now = local(8, 12);
    expect(separatorDay(local(8, 0, 1), now)).toBe('today');
    expect(separatorDay(local(7, 23, 59), now)).toBe('yesterday');
    expect(separatorDay(local(3, 14), now)).toBe('date');
    expect(separatorDay(new Date(2025, 11, 31, 10).getTime(), now)).toBe('dateYear');
  });
});
