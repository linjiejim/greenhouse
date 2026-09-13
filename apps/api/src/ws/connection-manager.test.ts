import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getById: vi.fn(),
}));

vi.mock('@greenhouse/db', () => ({
  getDb: () => ({ users: { getById: mocks.getById } }),
}));

import { ConnectionManager } from './connection-manager.js';

function makeConnection(role = 'team', tokenExp = Math.floor(Date.now() / 1000) + 3600, tokenAuthVersion = 0) {
  return {
    ws: {
      send: vi.fn(),
      close: vi.fn(),
    },
    userId: 'user-1',
    nickname: 'User One',
    role,
    connectedAt: '2026-07-21T00:00:00.000Z',
    tokenAuthVersion,
    tokenExp,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getById.mockResolvedValue({ id: 'user-1', status: 'active', role: 'team', auth_version: 0 });
});

describe('WebSocket account revalidation', () => {
  it('disconnects an account disabled after the socket opened', async () => {
    const manager = new ConnectionManager();
    const connection = makeConnection();
    manager.add(connection as never);
    mocks.getById.mockResolvedValue({ id: 'user-1', status: 'disabled', role: 'team', auth_version: 0 });

    await manager.pingAll();

    expect(connection.ws.close).toHaveBeenCalledWith(4001, 'Account unavailable');
    expect(manager.isOnline('user-1')).toBe(false);
    expect(connection.ws.send).not.toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));
  });

  it('updates a demoted super connection before future broadcasts', async () => {
    const manager = new ConnectionManager();
    const connection = makeConnection('super');
    manager.add(connection as never);

    await manager.pingAll();

    expect(manager.getOnlineUsers()).toMatchObject([{ userId: 'user-1', role: 'team' }]);
    expect(connection.ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'ping' }));

    connection.ws.send.mockClear();
    manager.broadcastToSuper({ type: 'presence:leave', userId: 'someone-else' });
    expect(connection.ws.send).not.toHaveBeenCalled();
  });

  it('fails closed when account state cannot be revalidated', async () => {
    const manager = new ConnectionManager();
    const connection = makeConnection();
    manager.add(connection as never);
    mocks.getById.mockRejectedValue(new Error('database unavailable'));

    await manager.pingAll();

    expect(connection.ws.close).toHaveBeenCalledWith(1011, 'Account validation failed');
    expect(manager.isOnline('user-1')).toBe(false);
  });

  it('disconnects a socket whose credential version was revoked by password reset', async () => {
    const manager = new ConnectionManager();
    const connection = makeConnection('team', Math.floor(Date.now() / 1000) + 3600, 2);
    manager.add(connection as never);
    mocks.getById.mockResolvedValue({ id: 'user-1', status: 'active', role: 'team', auth_version: 3 });

    await manager.pingAll();

    expect(connection.ws.close).toHaveBeenCalledWith(4001, 'Credentials revoked');
    expect(manager.isOnline('user-1')).toBe(false);
  });
});

describe('Runtime invalidation fan-out', () => {
  it('notifies the team owner and each super connection exactly once', () => {
    const manager = new ConnectionManager();
    const owner = makeConnection('team');
    const admin = {
      ...makeConnection('super'),
      userId: 'super-1',
      nickname: 'Super One',
      ws: { send: vi.fn(), close: vi.fn() },
    };
    manager.add(owner as never);
    manager.add(admin as never);
    owner.ws.send.mockClear();
    admin.ws.send.mockClear();
    const event = {
      type: 'runtime:invalidate',
      runId: 'rtm_1',
      kind: 'mission',
      eventType: 'run.updated',
      seq: 2,
    } as const;

    manager.sendToUser(owner.userId, event);
    manager.broadcastToSuperExcept(owner.userId, event);

    expect(owner.ws.send).toHaveBeenCalledTimes(1);
    expect(owner.ws.send).toHaveBeenCalledWith(JSON.stringify(event));
    expect(admin.ws.send).toHaveBeenCalledTimes(1);
    expect(admin.ws.send).toHaveBeenCalledWith(JSON.stringify(event));
  });
});
