/**
 * The outbox senders (./outbox.ts): the background flusher and an open conversation share one
 * per-message claim, a message is checked to still be queued right before it goes, leaves only
 * once the station accepted it, and a message sent without an answer is looked for before it goes
 * again. Runs in the ROOT vitest unit project: zustand, react-native and the APIs are mocked.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueuedTurn } from '../data/outbox';

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
vi.mock('../ui/dialogs', () => ({ alertError: vi.fn() }));

const api = {
  messages: vi.fn(),
  run: vi.fn(async () => ({ ok: true, data: { active: false } })),
  send: vi.fn(),
};
vi.mock('../api/assistant', () => ({
  getMessages: (...args: unknown[]) => api.messages(...args),
  chatRun: (...args: unknown[]) => api.run(...args),
  createSession: async () => ({ ok: true, data: { id: 'ses_new' } }),
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
  api.messages.mockReset();
  api.send.mockReset();
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

  it('looks for a message sent without an answer before sending it again', async () => {
    const queued = turn('a', { status: 'unknown' });
    useOutbox.setState({ items: [queued] });
    const send = vi.fn(async () => ({ ok: true as const }));
    api.messages.mockResolvedValueOnce({
      ok: true,
      data: { messages: [{ id: 'm', role: 'user', content: queued.text, seq: 1, created_at: new Date().toISOString() }], has_more: false, next_before_seq: null },
    });
    expect(await deliverQueued('a', send)).toBe('sent');
    expect(send).not.toHaveBeenCalled();
    expect(ids()).toEqual([]);

    useOutbox.setState({ items: [turn('b', { status: 'unknown' })] });
    api.messages.mockResolvedValueOnce({ ok: true, data: { messages: [], has_more: false, next_before_seq: null } });
    expect(await deliverQueued('b', send)).toBe('sent');
    expect(send).toHaveBeenCalledOnce();
  });
});
