/**
 * Resolving what the model calls "the files in this conversation".
 *
 * Two stores sit behind one chat — authenticated `chat_files` handles and the
 * public-read `/api/upload/:id` image path — and a tool that only knew the
 * first one told users an image sitting in the transcript did not exist. The
 * session bound has to hold across both, because the id comes from the model.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { normalizeFileRef, resolveConversationFiles } from '../conversation-files.js';

const IMAGE_ID = '1786519724089-e49df116-2d16-4c86-b430-c2fbb61fb926.jpg';

vi.mock('../../storage/uploads.js', () => ({
  isValidUploadId: (id: string) => /^(gen-)?\d+-[0-9a-f-]{36}\.[a-z]+$/i.test(id),
  getUpload: vi.fn(async (id: string) =>
    id === IMAGE_ID ? { buffer: Buffer.from('image-bytes'), contentType: 'image/jpeg' } : null,
  ),
  getObjectAtKey: vi.fn(async () => ({ buffer: Buffer.from('file-bytes'), contentType: 'text/csv' })),
}));

function fakeDb(opts: { chatFiles?: Array<{ id: string }>; sessionImages?: string[] } = {}): DatabaseProvider {
  return {
    chatFiles: {
      listBySessionAndIds: vi.fn(async (_s: string, ids: string[]) =>
        (opts.chatFiles ?? [])
          .filter((f) => ids.includes(f.id))
          .map((f) => ({ ...f, name: 'data.csv', content_type: 'text/csv', size: 10, storage_key: `k/${f.id}` })),
      ),
    },
    sessions: {
      sessionReferencesImage: vi.fn(async (_s: string, id: string) => (opts.sessionImages ?? []).includes(id)),
    },
  } as unknown as DatabaseProvider;
}

beforeEach(() => vi.clearAllMocks());

describe('normalizeFileRef', () => {
  it('accepts the URL form generate_image hands back', () => {
    // The tool returns both `id` and `url`; the model passed the url on dev and
    // got an error naming a path it had been given.
    expect(normalizeFileRef(`/api/upload/${IMAGE_ID}`)).toBe(IMAGE_ID);
  });

  it('strips query strings and fragments copied out of rendered markdown', () => {
    expect(normalizeFileRef(`${IMAGE_ID}?w=200`)).toBe(IMAGE_ID);
    expect(normalizeFileRef(`https://host/api/upload/${IMAGE_ID}#preview`)).toBe(IMAGE_ID);
  });

  it('leaves a bare id alone', () => {
    expect(normalizeFileRef(`  ${IMAGE_ID} `)).toBe(IMAGE_ID);
  });
});

describe('resolveConversationFiles', () => {
  it('resolves an ordinary chat attachment', async () => {
    const db = fakeDb({ chatFiles: [{ id: 'file-1' }] });
    const res = await resolveConversationFiles(db, 's1', ['file-1']);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(await res.files[0]!.read()).toEqual(Buffer.from('file-bytes'));
  });

  it('resolves an image the conversation actually contains', async () => {
    const db = fakeDb({ sessionImages: [IMAGE_ID] });
    const res = await resolveConversationFiles(db, 's1', [IMAGE_ID]);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.files[0]!.content_type).toBe('image/jpeg');
    expect(await res.files[0]!.read()).toEqual(Buffer.from('image-bytes'));
  });

  it('refuses an image from another conversation', async () => {
    // The session bound IS the authorization — an id copied out of someone
    // else's chat must not become an email attachment.
    const db = fakeDb({ sessionImages: [] });
    const res = await resolveConversationFiles(db, 's1', [IMAGE_ID]);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missing).toEqual([IMAGE_ID]);
  });

  it('never queries for a malformed id', async () => {
    const db = fakeDb();
    await resolveConversationFiles(db, 's1', ['../../etc/passwd']);
    expect(db.sessions.sessionReferencesImage).not.toHaveBeenCalled();
  });

  it('reports missing refs verbatim rather than dropping them', async () => {
    // Silently skipping one would send a mail whose body promises an
    // attachment it does not carry.
    const db = fakeDb({ chatFiles: [{ id: 'file-1' }] });
    const res = await resolveConversationFiles(db, 's1', ['file-1', 'file-ghost']);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.missing).toEqual(['file-ghost']);
  });

  it('does no work for an empty list', async () => {
    const db = fakeDb();
    expect(await resolveConversationFiles(db, 's1', [])).toEqual({ ok: true, files: [] });
    expect(db.chatFiles.listBySessionAndIds).not.toHaveBeenCalled();
  });
});
