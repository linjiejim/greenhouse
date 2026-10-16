import { describe, expect, it } from 'vitest';
import type { Agent, Conversation, NeedsYou } from '../shared/contract';
import {
  artKey,
  buildWidgetSnapshot,
  firstPendingRequest,
  snapshotArtKeys,
  widgetAgentPicks,
  widgetBadge,
  withoutMissingArt,
  type WidgetInput,
  type WidgetSource,
} from './model';

const parseMs = (iso: string) => Date.parse(iso);

function agent(id: string, partial: Partial<Agent> = {}): Agent {
  return {
    id,
    handle: id,
    name: id.toUpperCase(),
    role: `${id} role`,
    description: '',
    avatar: {},
    is_main: false,
    owner_id: 'm1',
    visibility: 'private',
    published_version: null,
    paused_at: null,
    template_key: null,
    current_version: 1,
    archived_at: null,
    last_active_at: null,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

function thread(agentId: string, partial: Partial<Conversation> = {}): Conversation {
  return {
    id: `c_${agentId}`,
    kind: 'direct',
    title: '',
    agent_id: agentId,
    model: null,
    origin: 'app',
    read_only: false,
    last_seq: 1,
    last_read_seq: 1,
    unread: 0,
    pinned: false,
    archived: false,
    muted: false,
    working: false,
    pending_requests: 0,
    last_activity_at: '2026-10-10T08:00:00.000Z',
    created_at: '2026-10-01T00:00:00.000Z',
    ...partial,
  };
}

function card(id: string, partial: Partial<NeedsYou> = {}): NeedsYou {
  return {
    id,
    kind: 'approval',
    subject: 'tool_write',
    status: 'pending',
    conversation_id: 'c_b',
    run_id: null,
    agent_id: 'b',
    title: `Approve ${id}`,
    payload: {},
    result: null,
    expires_at: null,
    decided_at: null,
    created_at: '2026-10-10T09:00:00.000Z',
    ...partial,
  };
}

const main = agent('greeny', { is_main: true, name: 'Greeny', template_key: 'main' });
const mainThread = thread('greeny', { id: 'c_main', kind: 'main' });

function source(over: Partial<WidgetSource> = {}): WidgetSource {
  return {
    agents: [main, agent('a'), agent('b'), agent('c'), agent('d'), agent('e')],
    conversations: [
      mainThread,
      thread('a', { last_activity_at: '2026-10-10T10:00:00.000Z' }),
      thread('b', { last_activity_at: '2026-10-10T12:00:00.000Z' }),
      thread('c', { last_activity_at: '2026-10-10T11:00:00.000Z' }),
      thread('d', { last_activity_at: '2026-10-10T09:00:00.000Z' }),
      thread('e', { last_activity_at: '2026-10-10T07:00:00.000Z' }),
    ],
    requests: [],
    ...over,
  };
}

const ids = (picks: ReturnType<typeof widgetAgentPicks>) => picks.map((pick) => pick.agent.id);

describe('widgetAgentPicks', () => {
  it('pins the main Agent, then the Agent threads by recent activity, four in all', () => {
    const picks = widgetAgentPicks(source(), parseMs);
    expect(ids(picks)).toEqual(['greeny', 'b', 'c', 'a']);
    expect(picks[0]!.conversation?.id).toBe('c_main');
  });

  it('skips archived Agents, archived threads and Agents without a thread', () => {
    const s = source({
      agents: [main, agent('a', { archived_at: '2026-10-09T00:00:00.000Z' }), agent('b'), agent('x')],
      conversations: [mainThread, thread('a'), thread('b', { archived: true })],
    });
    expect(ids(widgetAgentPicks(s, parseMs))).toEqual(['greeny']);
  });

  it('lets an Agent waiting on the member past the cut take the last slot that is not waiting', () => {
    const conversations = source().conversations.map((item) =>
      item.agent_id === 'e' ? { ...item, pending_requests: 2 } : item,
    );
    expect(ids(widgetAgentPicks(source({ conversations }), parseMs))).toEqual(['greeny', 'b', 'c', 'e']);
  });

  it('never replaces the main Agent, even when every other slot is waiting', () => {
    const conversations = source().conversations.map((item) =>
      item.kind === 'direct' ? { ...item, pending_requests: 1 } : item,
    );
    expect(ids(widgetAgentPicks(source({ conversations }), parseMs))).toEqual(['greeny', 'b', 'c', 'a']);
  });

  it('keeps the main Agent before its thread is listed', () => {
    const picks = widgetAgentPicks(source({ conversations: [] }), parseMs);
    expect(picks).toEqual([{ agent: main, conversation: null }]);
  });
});

describe('widgetBadge', () => {
  it('pending cards beat unread messages', () => {
    expect(widgetBadge(thread('a', { pending_requests: 2, unread: 5 }))).toEqual({ badge: 'needs_you', count: 2 });
    expect(widgetBadge(thread('a', { unread: 5 }))).toEqual({ badge: 'unread', count: 5 });
  });

  it('a muted, a working or a read thread carries no badge', () => {
    expect(widgetBadge(thread('a', { unread: 3, muted: true }))).toEqual({ badge: null, count: null });
    expect(widgetBadge(thread('a', { working: true }))).toEqual({ badge: null, count: null });
    expect(widgetBadge(null)).toEqual({ badge: null, count: null });
  });
});

describe('firstPendingRequest', () => {
  it('is the oldest pending card of that conversation', () => {
    const requests = [
      card('late', { created_at: '2026-10-10T10:00:00.000Z' }),
      card('early', { created_at: '2026-10-10T08:00:00.000Z' }),
      card('decided', { created_at: '2026-10-10T07:00:00.000Z', status: 'approved' }),
      card('elsewhere', { created_at: '2026-10-10T06:00:00.000Z', conversation_id: 'c_a' }),
    ];
    expect(firstPendingRequest(requests, 'c_b')?.id).toBe('early');
    expect(firstPendingRequest(requests, 'c_z')).toBeNull();
  });
});

describe('buildWidgetSnapshot', () => {
  const input = (over: Partial<WidgetInput> = {}): WidgetInput => ({
    now: 1000,
    nickname: 'Jim',
    lang: 'zh',
    source: source(),
    parseMs,
    ...over,
  });

  it('before the Agents load: no entries and no default Agent', () => {
    const { snapshot } = buildWidgetSnapshot(input({ source: null }));
    expect(snapshot).toMatchObject({ v: 2, bots: [], defaultAgent: null, nickname: 'Jim', lang: 'zh' });
  });

  it('one entry per pick, with the deep-link fields, the signal and the face that goes with it', () => {
    const conversations = source().conversations.map((item) =>
      item.agent_id === 'b' ? { ...item, pending_requests: 1 } : item.agent_id === 'c' ? { ...item, unread: 3 } : item,
    );
    const { snapshot, jobs } = buildWidgetSnapshot(input({ source: source({ conversations, requests: [card('r1')] }) }));
    const [first, b, c] = snapshot.bots!;
    expect(first).toMatchObject({ id: 'greeny', sessionId: 'c_main', sprouty: true, badge: null, preview: 'greeny role' });
    expect(b).toMatchObject({
      id: 'b',
      sessionId: 'c_b',
      sprouty: false,
      badge: 'needs_you',
      count: 1,
      requestId: 'r1',
      preview: 'Approve r1',
      lastAt: Date.parse('2026-10-10T12:00:00.000Z'),
    });
    expect(c).toMatchObject({ badge: 'unread', count: 3, requestId: null, preview: 'c role' });
    // the waiting face differs from the resting one
    expect(b!.art.light).not.toBe(c!.art.light);
    for (const key of snapshotArtKeys(snapshot)) expect(jobs.some((job) => job.key === key)).toBe(true);
  });

  it('the main Agent is the default one, with its resting and its late-night face', () => {
    const { snapshot } = buildWidgetSnapshot(input());
    expect(snapshot.defaultAgent?.name).toBe('Greeny');
    expect(snapshot.defaultAgent?.art.light).not.toBe(snapshot.defaultAgent?.sleep.light);
  });

  it('a face that failed to render is cleared, the rest kept', () => {
    const { snapshot } = buildWidgetSnapshot(input());
    const keep = new Set([snapshot.bots![0]!.art.light]);
    const cleaned = withoutMissingArt(snapshot, keep);
    expect(cleaned.bots![0]!.art).toEqual({ light: snapshot.bots![0]!.art.light, dark: '' });
    expect(cleaned.defaultAgent?.sleep).toEqual({ light: '', dark: '' });
  });
});

describe('artKey', () => {
  it('is stable and tells different faces apart', () => {
    expect(artKey('<svg/>')).toBe(artKey('<svg/>'));
    expect(artKey('<svg/>')).not.toBe(artKey('<svg />'));
    expect(artKey('<svg/>')).toMatch(/^a[0-9a-f]{8}[0-9a-z]+$/);
  });
});
