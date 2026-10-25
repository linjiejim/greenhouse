/**
 * The outbox senders (./outbox.ts): the background flusher and an open conversation share one
 * per-message claim, a message is checked to still be queued right before it goes, and leaves
 * only once the station accepted it (or says it already saved that turn). Runs in the ROOT
 * vitest unit project: zustand, react-native and the APIs are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseOutbox, type QueuedTurn } from '../data/outbox';

vi.mock('zustand', () => ({
  create: <S extends object>(init: () => S) => {
    let state = init();
    const get = () => state;
    const set = (partial: Partial<S>) => {
      state = { ...state, ...partial };
    };
    return Object.assign(() => state, { getState: get, setState: set, subscribe: () => () => {} });
  },
}));
vi.mock('react-native', () => ({ AppState: { addEventListener: () => ({ remove: () => {} }) } }));
vi.mock('./auth', () => ({ useAuth: { getState: () => ({ user: { id: 'u' } }), subscribe: () => () => {} } }));
vi.mock('./stations', () => ({ useStations: { getState: () => ({ activeId: 's' }), subscribe: () => () => {} } }));
vi.mock('./offline', () => ({ readOffline: async () => [], writeOffline: () => {} }));
vi.mock('../data/identity', () => ({ captureIdentity: () => () => true }));
vi.mock('../lib/i18n', () => ({ t: (key: string) => key }));
const confirm: { answers: boolean[]; pending?: () => Promise<boolean> } = { answers: [] };
vi.mock('../ui/dialogs', () => ({
  alertError: vi.fn(),
  confirmAction: async () => (confirm.pending ? confirm.pending() : (confirm.answers.shift() ?? false)),
}));

const api = { send: vi.fn() };
const session: { answer: unknown; agents: (string | null | undefined)[] } = { answer: { ok: true, data: { id: 'ses_new' } }, agents: [] };
vi.mock('../api/assistant', () => ({
  createSession: async (agentId?: string | null) => {
    session.agents.push(agentId);
    return session.answer;
  },
}));
vi.mock('../chat/send', () => ({ sendMessage: (...args: unknown[]) => api.send(...args) }));

const { useOutbox, deliverQueued, flushOutbox, claimConversation, _resetOutbox } = await import('./outbox');

const turn = (id: string, extra: Partial<QueuedTurn> = {}): QueuedTurn => ({
  id,
  sessionId: 'ses_1',
  text: `words ${id}`,
  images: [],
  createdAt: Date.now(),
  ...extra,
});
const ids = () => useOutbox.getState().items.map((item) => item.id);

beforeEach(() => {
  _resetOutbox();
  api.send.mockReset();
  session.answer = { ok: true, data: { id: 'ses_new' } };
  session.agents = [];
  confirm.answers = [];
  confirm.pending = undefined;
});

describe('sending queued messages', () => {
  it('sends a message once when the flusher and an opened conversation both reach it', async () => {
    useOutbox.setState({ items: [turn('a')] });
    let land: (value: unknown) => void = () => {};
    api.send.mockImplementation(() => new Promise((resolve) => (land = resolve)));
    const flushing = flushOutbox();
    await vi.waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));

    // the conversation opens while the flusher's send is on its way
    const release = claimConversation('ses_1');
    const screen = vi.fn(async () => ({ ok: true as const }));
    expect(await deliverQueued('a', screen)).toBeNull();
    land({ ok: true, finished: true });
    await flushing;
    expect(screen).not.toHaveBeenCalled();
    expect(ids()).toEqual([]);

    // and a stale copy of a message that already went is not sent again
    expect(await deliverQueued('a', screen)).toBeNull();
    release();
  });

  it('keeps the message when the send was not accepted', async () => {
    useOutbox.setState({ items: [turn('a'), turn('b', { sessionId: 'ses_2' })] });
    expect(await deliverQueued('a', async () => ({ ok: false, status: 0, message: '' }))).toBe('unknown');
    expect(await deliverQueued('b', async () => ({ ok: false, status: 409, message: 'busy' }))).toBe('retry');
    expect(ids()).toEqual(['a', 'b']);
    const [a, b] = useOutbox.getState().items;
    expect(a!.status).toBe('unknown');
    expect(b!.attempts).toBe(1);
    expect(b!.retryAt).toBeGreaterThan(Date.now());
    // not due yet: the next pass leaves it alone
    expect(await deliverQueued('b', async () => ({ ok: true }))).toBeNull();
  });

  it('keeps a refused message as failed until the member retries it', async () => {
    useOutbox.setState({ items: [turn('a')] });
    expect(await deliverQueued('a', async () => ({ ok: false, status: 400, message: 'Too long' }))).toBe('rejected');
    expect(useOutbox.getState().items[0]).toMatchObject({ status: 'failed', error: 'Too long' });
    expect(await deliverQueued('a', async () => ({ ok: true }))).toBeNull();
    expect(await deliverQueued('a', async () => ({ ok: true }), { manual: true })).toBe('sent');
    expect(ids()).toEqual([]);
  });

  it('dequeues a turn the station says it already saved', async () => {
    useOutbox.setState({ items: [turn('a', { status: 'unknown' })] });
    expect(await deliverQueued('a', async () => ({ ok: false, status: 409, code: 'duplicate_turn', message: '' }))).toBe('sent');
    expect(ids()).toEqual([]);
  });

  it('sends every attempt under the queued id', async () => {
    useOutbox.setState({ items: [turn('q-abc-123456')] });
    api.send.mockResolvedValue({ ok: false, status: 0, code: 'network', message: '' });
    await flushOutbox();
    expect(api.send).toHaveBeenLastCalledWith('ses_1', 'words q-abc-123456', expect.any(Function), undefined, [], 'q-abc-123456');
  });

  it('retries a first message when starting its conversation was briefly refused', async () => {
    useOutbox.setState({ items: [turn('n', { sessionId: null })] });
    session.answer = { ok: false, status: 503, code: 'unavailable', message: 'down' };
    await flushOutbox();
    expect(ids()).toEqual(['n']);
    expect(useOutbox.getState().items[0]).toMatchObject({ attempts: 1, sessionId: null });
    expect(useOutbox.getState().items[0]!.retryAt).toBeGreaterThan(Date.now());
    expect(api.send).not.toHaveBeenCalled();
  });

  it('asks the member about a first message the station refused to start a conversation for', async () => {
    useOutbox.setState({ items: [turn('n', { sessionId: null }), turn('m', { sessionId: null })] });
    session.answer = { ok: false, status: 403, code: 'forbidden', message: 'Not allowed' };
    confirm.answers = [true, false];
    await flushOutbox();
    await vi.waitFor(() => expect(ids()).toEqual(['m']));
    // kept: tried again later
    expect(useOutbox.getState().items[0]).toMatchObject({ attempts: 1 });
    expect(useOutbox.getState().items[0]!.status).toBeUndefined();
  });


  it('asks again after a restart while the question was open, and only once at a time', async () => {
    useOutbox.setState({ items: [turn('n', { sessionId: null })] });
    session.answer = { ok: false, status: 403, code: 'forbidden', message: 'Not allowed' };
    let asked = 0;
    confirm.pending = () => {
      asked += 1;
      return new Promise<boolean>(() => {}); // the app is killed before the member answers
    };
    await flushOutbox();
    await flushOutbox();
    expect(asked).toBe(1);

    // restart: the saved outbox comes back, nothing in memory
    const saved = parseOutbox(JSON.parse(JSON.stringify(useOutbox.getState().items)));
    _resetOutbox();
    useOutbox.setState({ items: saved });
    await flushOutbox();
    expect(asked).toBe(2);
  });

  it('starts a queued first message with the agent it was written to, across a restart', async () => {
    const saved = parseOutbox(JSON.parse(JSON.stringify([turn('n', { sessionId: null, agentId: 'bot_7' })])));
    useOutbox.setState({ items: saved });
    api.send.mockResolvedValue({ ok: true });
    await flushOutbox();
    expect(session.agents).toEqual(['bot_7']);
  });

  it('starts a conversation again for a first message saved as failed by an older build', () => {
    expect(parseOutbox([{ ...turn('n', { sessionId: null }), status: 'failed', error: 'x' }])[0]!.status).toBeUndefined();
    expect(parseOutbox([{ ...turn('s'), status: 'failed' }])[0]!.status).toBe('failed');
  });
});
