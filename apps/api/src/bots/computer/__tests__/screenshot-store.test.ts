/**
 * Where a Bot's screenshot goes: a chat file of the conversation behind the
 * authenticated download route — never the flat public upload store, whose
 * URLs work for anyone who ever sees one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';

const storage = vi.hoisted(() => ({
  putObjectAtKey: vi.fn(async () => undefined),
  deleteObjectAtKey: vi.fn(async () => undefined),
  putUpload: vi.fn(async () => undefined),
}));
vi.mock('../../../storage/uploads.js', () => storage);

const { storeScreenshotAsChatFile } = await import('../browser-session.js');
const { isPublicPath } = await import('../../../auth/middleware.js');

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function dbWith(create: (input: Record<string, unknown>) => Promise<unknown>) {
  const chatFiles = { create: vi.fn(create) };
  return { db: { chatFiles } as unknown as DatabaseProvider, chatFiles };
}

describe('storeScreenshotAsChatFile', () => {
  beforeEach(() => {
    storage.putObjectAtKey.mockClear();
    storage.deleteObjectAtKey.mockClear();
    storage.putUpload.mockClear();
  });

  it('stores the PNG as an agent chat file of the conversation, behind the authenticated route', async () => {
    const { db, chatFiles } = dbWith(async (input) => ({ id: 'cf_9', ...input }));
    const stored = await storeScreenshotAsChatFile(PNG, { db, userId: 'u1', sessionId: 'sess_7' });

    expect(storage.putUpload).not.toHaveBeenCalled();
    const [key, bytes, contentType] = storage.putObjectAtKey.mock.calls[0] as unknown as [string, Buffer, string];
    expect(key).toMatch(/^chat-files\/u1\/[0-9a-f-]{36}\/screenshot-\d{8}-\d{6}\.png$/);
    expect(bytes).toBe(PNG);
    expect(contentType).toBe('image/png');
    expect(chatFiles.create).toHaveBeenCalledWith({
      session_id: 'sess_7',
      name: expect.stringMatching(/^screenshot-.*\.png$/),
      content_type: 'image/png',
      size: PNG.length,
      storage_key: key,
      source: 'agent',
      created_by: 'u1',
    });
    expect(stored).toEqual({
      file_id: 'cf_9',
      name: expect.stringMatching(/^screenshot-/),
      size: PNG.length,
      download_url: '/api/chat-files/cf_9/content',
    });
    // The download route needs a token; the old upload path did not.
    expect(isPublicPath(stored.download_url)).toBe(false);
    expect(isPublicPath('/api/upload/1-x.png')).toBe(true);
  });

  it('deletes the object when the chat-file row cannot be written', async () => {
    const { db } = dbWith(async () => {
      throw new Error('db down');
    });
    await expect(storeScreenshotAsChatFile(PNG, { db, userId: 'u1', sessionId: 'sess_7' })).rejects.toThrow('db down');
    const [key] = storage.putObjectAtKey.mock.calls[0] as unknown as [string];
    expect(storage.deleteObjectAtKey).toHaveBeenCalledWith(key);
  });
});
