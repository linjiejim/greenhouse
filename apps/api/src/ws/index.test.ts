/**
 * /api/ws onOpen must never reject: @hono/node-server does not await it, so a
 * rejection is unhandled and Node exits the whole API (a postgres
 * CONNECT_TIMEOUT once did exactly that). A failed account lookup closes the
 * socket with 1011, which the web and mobile clients retry with backoff.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WSContext, WSEvents } from 'hono/ws';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
  factory: null as null | ((c: unknown) => WSEvents),
}));

vi.mock('@hono/node-server', () => ({
  upgradeWebSocket: (factory: (c: unknown) => WSEvents) => {
    mocks.factory = factory;
    return async () => new Response(null, { status: 426 });
  },
}));

vi.mock('../auth/token.js', () => ({
  validateAccessToken: (token: string) =>
    token === 'good'
      ? { uid: 'user-1', role: 'team', authVersion: 0, exp: Math.floor(Date.now() / 1000) + 3600 }
      : null,
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({
    users: { getById: mocks.getById },
    sessionShares: { countUnread: vi.fn(async () => 0) },
    notifications: { countUnread: vi.fn(async () => 0) },
  }),
}));

import { logger } from '@greenhouse/utils/logger';
import { connectionManager } from './connection-manager.js';
import './index.js';

function socket() {
  return { send: vi.fn(), close: vi.fn() } as unknown as WSContext & {
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
}

function open(token = 'good') {
  const events = mocks.factory!({ req: { url: `http://localhost/api/ws?token=${token}` } });
  return events;
}

beforeEach(() => {
  mocks.getById.mockResolvedValue({ id: 'user-1', status: 'active', role: 'team', auth_version: 0, nickname: 'Ana' });
});

afterEach(() => {
  connectionManager.disconnectUser('user-1');
  vi.restoreAllMocks();
});

describe('/api/ws onOpen', () => {
  it('a DB error during the account lookup closes with 1011 instead of rejecting', async () => {
    const warn = vi.spyOn(logger, 'warn');
    mocks.getById.mockRejectedValueOnce(Object.assign(new Error('write CONNECT_TIMEOUT'), { code: 'CONNECT_TIMEOUT' }));
    const ws = socket();

    await expect(open().onOpen!(new Event('open'), ws)).resolves.toBeUndefined();

    expect(ws.close).toHaveBeenCalledWith(1011, 'Account validation failed');
    expect(connectionManager.isOnline('user-1')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('closing with 1011'), {
      error: expect.stringContaining('CONNECT_TIMEOUT'),
    });
  });

  it('does not throw even when closing the socket throws', async () => {
    mocks.getById.mockRejectedValueOnce(new Error('ECONNRESET'));
    const ws = socket();
    ws.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    await expect(open().onOpen!(new Event('open'), ws)).resolves.toBeUndefined();
  });

  it('registers a valid account and confirms the connection', async () => {
    const ws = socket();
    await open().onOpen!(new Event('open'), ws);
    expect(connectionManager.isOnline('user-1')).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'connected', userId: 'user-1' }));
    expect(ws.close).not.toHaveBeenCalled();
  });

  it('never registers a socket that closed while the lookup was in flight', async () => {
    let resolveLookup: (row: unknown) => void = () => {};
    mocks.getById.mockReturnValueOnce(new Promise((resolve) => (resolveLookup = resolve)));
    const events = open();
    const ws = socket();
    const opening = events.onOpen!(new Event('open'), ws);
    events.onClose!(new Event('close') as CloseEvent, ws);
    resolveLookup({ id: 'user-1', status: 'active', role: 'team', auth_version: 0, nickname: 'Ana' });
    await opening;
    expect(connectionManager.isOnline('user-1')).toBe(false);
  });

  it('keeps 4001 for an account that is not allowed in', async () => {
    mocks.getById.mockResolvedValueOnce({ id: 'user-1', status: 'disabled', role: 'team', auth_version: 0 });
    const ws = socket();
    await open().onOpen!(new Event('open'), ws);
    expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized');
    expect(connectionManager.isOnline('user-1')).toBe(false);
  });
});
