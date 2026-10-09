import { describe, expect, it } from 'vitest';
import type { BotConversationSummary, BotRequestView, BotView } from '../shared/bots';
import type { RowCopy } from '../bots/drawer/row-text';
import {
  artKey,
  buildWidgetSnapshot,
  firstPendingRequest,
  snapshotArtKeys,
  widgetBadge,
  widgetBotPicks,
  withoutMissingArt,
  type WidgetBotsSource,
  type WidgetInput,
} from './model';

function bot(id: string, partial: Partial<BotView> = {}): BotView {
  return {
    id,
    name: id.toUpperCase(),
    role: '',
    description: '',
    instructions: '',
    avatar: {},
    model_id: null,
    tools: null,
    max_steps: null,
    template_key: null,
    status: 'active',
    dm_session_id: `dm_${id}`,
    current_version: 1,
    user_id: 'u1',
    last_active_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

function dm(botId: string, partial: Partial<BotConversationSummary> = {}): BotConversationSummary {
  return {
    session_id: `dm_${botId}`,
    kind: 'direct',
    title: null,
    owner_bot_id: botId,
    lead_bot_id: botId,
    members: [{ bot_id: botId, role: 'owner', position: 0 }],
    last_message: null,
    attention: 'idle',
    pending_requests: 0,
    unread_count: 0,
    last_activity_at: '2026-10-09T10:00:00.000Z',
    ...partial,
  };
}

function request(id: string, sessionId: string, created: string, status: BotRequestView['status'] = 'pending') {
  return {
    id,
    session_id: sessionId,
    bot_id: null,
    kind: 'approval',
    status,
    payload: {},
    result: null,
    expires_at: null,
    created_at: created,
  } as unknown as BotRequestView;
}

const sprouty = bot('sprouty', { name: 'Sprouty', template_key: 'sprouty' });

/** Bots + their DMs, the server's order (newest activity first) = the order given. */
function source(rows: BotConversationSummary[], extra: Partial<WidgetBotsSource> = {}): WidgetBotsSource {
  const bots = [
    sprouty,
    ...rows.flatMap((r) => (r.owner_bot_id && r.owner_bot_id !== 'sprouty' ? [bot(r.owner_bot_id)] : [])),
  ];
  return {
    bots,
    byId: Object.fromEntries(bots.map((b) => [b.id, b])),
    botsLoaded: true,
    conversations: rows,
    pendingRequests: [],
    ...extra,
  };
}

const ids = (s: WidgetBotsSource) => widgetBotPicks(s).map((p) => p.bot.id);

describe('widgetBotPicks', () => {
  it('pins Sprouty, then the replyable DMs by recent activity, four in all', () => {
    const s = source([dm('a'), dm('sprouty'), dm('b'), dm('c'), dm('d')]);
    expect(ids(s)).toEqual(['sprouty', 'a', 'b', 'c']);
  });

  it('skips archived Bots and retired group chats', () => {
    const s = source([dm('a'), dm('b'), { ...dm('g'), kind: 'group', owner_bot_id: null, session_id: 'grp' }, dm('c')]);
    s.bots = s.bots.filter((b) => b.id !== 'b');
    expect(ids(s)).toEqual(['sprouty', 'a', 'c']);
  });

  it('lets a Bot waiting on the member past the cut take the last slot that is not waiting', () => {
    const s = source([
      dm('a'),
      dm('b', { pending_requests: 1 }),
      dm('c'),
      dm('d'),
      dm('e', { pending_requests: 2 }),
      dm('f', { pending_requests: 1 }),
    ]);
    // c (last, not waiting) → e; then a (b is waiting) → f; Sprouty never moves.
    expect(ids(s)).toEqual(['sprouty', 'f', 'b', 'e']);
  });

  it('never replaces Sprouty, even when every other slot is waiting', () => {
    const waiting = { pending_requests: 1 };
    const s = source([dm('a', waiting), dm('b', waiting), dm('c', waiting), dm('d', waiting)]);
    expect(ids(s)).toEqual(['sprouty', 'a', 'b', 'c']);
  });

  it('shows nothing until the Bot list has answered', () => {
    expect(widgetBotPicks({ ...source([dm('a')]), botsLoaded: false })).toEqual([]);
  });

  it('keeps Sprouty without a DM yet (row null)', () => {
    const picks = widgetBotPicks(source([dm('a')]));
    expect(picks[0]).toMatchObject({ bot: { id: 'sprouty' }, row: null });
  });
});

describe('widgetBadge', () => {
  it('pending cards beat unread replies', () => {
    expect(widgetBadge(dm('a', { pending_requests: 2, attention: 'needs_you', unread_count: 5 }))).toEqual({
      badge: 'needs_you',
      count: 2,
    });
  });
  it('counts unread replies; no count → a dot', () => {
    expect(widgetBadge(dm('a', { attention: 'unread', unread_count: 5 }))).toEqual({ badge: 'unread', count: 5 });
    expect(widgetBadge(dm('a', { attention: 'unread', unread_count: undefined }))).toEqual({
      badge: 'unread',
      count: null,
    });
    // Only system events arrived: unread, but no Bot reply to count.
    expect(widgetBadge(dm('a', { attention: 'unread', unread_count: 0 }))).toEqual({ badge: 'unread', count: null });
  });
  it('working and idle rows carry no badge (a snapshot would show "replying" long after it ended)', () => {
    expect(widgetBadge(dm('a', { attention: 'working' }))).toEqual({ badge: null, count: null });
    expect(widgetBadge(null)).toEqual({ badge: null, count: null });
  });
});

describe('firstPendingRequest', () => {
  it('is the oldest pending card of that conversation', () => {
    const requests = [
      request('r3', 'dm_a', '2026-10-09T10:03:00.000Z'),
      request('r1', 'dm_a', '2026-10-09T10:01:00.000Z', 'approved'),
      request('r2', 'dm_a', '2026-10-09T10:02:00.000Z'),
      request('r0', 'dm_b', '2026-10-09T10:00:00.000Z'),
    ];
    expect(firstPendingRequest(requests, 'dm_a')).toBe('r2');
    expect(firstPendingRequest(requests, 'dm_c')).toBeNull();
  });
});

const copy: RowCopy = {
  deletedBot: 'Deleted Bot',
  untitledGroup: 'Group',
  archivedName: (name) => `${name} (archived)`,
  youSaid: (text) => `You: ${text}`,
  botSaid: (name, text) => `${name}: ${text}`,
  noMessages: 'No messages yet',
};

function input(partial: Partial<WidgetInput> = {}): WidgetInput {
  return {
    now: 1_000,
    nickname: 'Jim',
    lang: 'en',
    bots: null,
    defaultAgent: { name: 'Sprouty', avatar: sprouty },
    sessions: [{ id: 's1', title: 'Plan', updatedAt: 5 }],
    copy,
    parseMs: (iso) => Date.parse(iso),
    ...partial,
  };
}

describe('buildWidgetSnapshot', () => {
  it('without Bots: the recent sessions, no Bot list', () => {
    const { snapshot } = buildWidgetSnapshot(input());
    expect(snapshot).toMatchObject({ v: 2, nickname: 'Jim', bots: null, sessions: [{ id: 's1' }] });
  });

  it('with Bots: one entry per pick, the deep-link fields and the face that goes with the signal', () => {
    const s = source(
      [
        dm('a', {
          pending_requests: 1,
          attention: 'needs_you',
          last_message: {
            preview: 'Publish  the\nreport?',
            bot_id: 'a',
            role: 'assistant',
            created_at: '2026-10-09T10:05:00.000Z',
          },
        }),
        dm('b', {
          attention: 'unread',
          unread_count: 3,
          last_message: { preview: 'hi', bot_id: null, role: 'user', created_at: '2026-10-09T09:00:00.000Z' },
        }),
      ],
      { pendingRequests: [request('r9', 'dm_a', '2026-10-09T10:04:00.000Z')] },
    );
    s.bots = s.bots.map((b) => (b.id === 'sprouty' ? { ...b, dm_session_id: null } : b));
    const { snapshot, jobs } = buildWidgetSnapshot(input({ bots: s }));
    expect(snapshot.sessions).toEqual([]);
    expect(snapshot.bots).toMatchObject([
      { id: 'sprouty', sessionId: null, sprouty: true, badge: null, requestId: null, preview: '', lastAt: null },
      { id: 'a', sessionId: 'dm_a', badge: 'needs_you', count: 1, requestId: 'r9', preview: 'Publish the report?' },
      { id: 'b', sessionId: 'dm_b', badge: 'unread', count: 3, requestId: null, preview: 'You: hi' },
    ]);
    expect(snapshot.bots?.[1].lastAt).toBe(Date.parse('2026-10-09T10:05:00.000Z'));
    const [, waiting, resting] = snapshot.bots!;
    expect(waiting.art.light).not.toBe(waiting.art.dark);
    // a and b are different Bots anyway; the same Bot waiting vs at rest is a different face too:
    const calm = buildWidgetSnapshot(input({ bots: { ...s, conversations: [dm('a'), s.conversations[1]] } }));
    expect(calm.snapshot.bots?.[1].art.light).not.toBe(waiting.art.light);
    expect(resting.art.light).toMatch(/^a[0-9a-f]{8}[0-9a-z]+$/);
    // every key the snapshot points at has exactly one job
    expect(new Set(jobs.map((j) => j.key))).toEqual(new Set(snapshotArtKeys(snapshot)));
    expect(jobs.every((j) => j.svg.startsWith('<svg ') && !j.svg.includes('class='))).toBe(true);
  });

  it('the default agent gets its resting and its late-night face; none known → Sprouty’s plant', () => {
    const known = buildWidgetSnapshot(input()).snapshot.defaultAgent!;
    expect(known.name).toBe('Sprouty');
    expect(known.sleep.light).not.toBe(known.art.light);
    const unknown = buildWidgetSnapshot(input({ defaultAgent: { name: 'Sprouty', avatar: null } })).snapshot;
    expect(unknown.defaultAgent?.art).toEqual(known.art);
    expect(buildWidgetSnapshot(input({ defaultAgent: null })).snapshot.defaultAgent).toBeNull();
  });

  it('a face that failed to render is cleared, the rest kept', () => {
    const { snapshot } = buildWidgetSnapshot(input({ bots: source([dm('a')]) }));
    const keep = new Set([snapshot.bots![1].art.light]);
    const pruned = withoutMissingArt(snapshot, keep);
    expect(pruned.bots![1].art).toEqual({ light: snapshot.bots![1].art.light, dark: '' });
    expect(pruned.defaultAgent?.art).toEqual({ light: '', dark: '' });
  });
});

describe('artKey', () => {
  it('is stable and tells different faces apart', () => {
    expect(artKey('<svg a/>')).toBe(artKey('<svg a/>'));
    expect(artKey('<svg a/>')).not.toBe(artKey('<svg b/>'));
  });
});
