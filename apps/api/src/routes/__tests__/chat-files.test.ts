import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEnv } from '../../app-env.js';

const mocks = vi.hoisted(() => ({
  chatFiles: {
    getById: vi.fn(),
  },
  sessions: {
    getById: vi.fn(),
  },
  sessionShares: {
    getSharedSessionIds: vi.fn(),
  },
  getObjectAtKey: vi.fn(),
  presignGetUrl: vi.fn(),
}));

vi.mock('@greenhouse/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@greenhouse/db')>();
  return { ...actual, getDb: () => mocks };
});

vi.mock('../../storage/uploads.js', () => ({
  getObjectAtKey: mocks.getObjectAtKey,
  presignGetUrl: mocks.presignGetUrl,
}));

import chatFileRoutes from '../chat-files.js';

function createApp() {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', {
      id: c.req.header('x-user') ?? 'owner',
      role: c.req.header('x-role') === 'super' ? 'super' : 'team',
    });
    return next();
  });
  app.route('/api/chat-files', chatFileRoutes);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.chatFiles.getById.mockResolvedValue({
    id: 'file-1',
    session_id: 'session-1',
    name: 'crm-customers.xlsx',
    content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 4,
    storage_key: 'drive/chat/file-1.xlsx',
  });
  mocks.sessions.getById.mockResolvedValue({ id: 'session-1', user_id: 'owner' });
  mocks.sessionShares.getSharedSessionIds.mockResolvedValue([]);
  mocks.presignGetUrl.mockResolvedValue(null);
  mocks.getObjectAtKey.mockResolvedValue({
    buffer: Buffer.from('xlsx'),
    contentType: 'application/octet-stream',
  });
});

describe('GET /api/chat-files/:id/content', () => {
  it.each([
    ['owner', { 'x-user': 'owner' }],
    ['super', { 'x-user': 'admin', 'x-role': 'super' }],
  ])('serves an authenticated attachment to the %s', async (_label, headers) => {
    const response = await createApp().request('/api/chat-files/file-1/content', { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-disposition')).toContain('crm-customers.xlsx');
    expect(await response.text()).toBe('xlsx');
  });

  it('allows a read-only session share recipient', async () => {
    mocks.sessionShares.getSharedSessionIds.mockResolvedValue(['session-1']);
    const response = await createApp().request('/api/chat-files/file-1/content', {
      headers: { 'x-user': 'reader' },
    });
    expect(response.status).toBe(200);
  });

  it('returns 404 without revealing the file to an unrelated user', async () => {
    const response = await createApp().request('/api/chat-files/file-1/content', {
      headers: { 'x-user': 'stranger' },
    });
    expect(response.status).toBe(404);
    expect(mocks.getObjectAtKey).not.toHaveBeenCalled();
  });
});
