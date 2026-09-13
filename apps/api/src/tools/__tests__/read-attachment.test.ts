/**
 * read_attachment — the session bound and the honest refusal.
 *
 * Two things carry weight here. The file id comes from the MODEL, so the
 * session scope is the only thing standing between a copied id and another
 * conversation's file. And when the tool cannot read something it must say so
 * — that refusal is what routes the work (to a sandbox per spec D1, or back to
 * the user when the sandbox cannot do better either); a tool that quietly
 * returned mojibake, or the empty string a scanned page really does extract to,
 * would let the agent "summarize" a PDF it never read.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { createReadAttachmentTool } from '../read-attachment.js';
import { encryptedPdf, pdfWithText, pdfWithoutTextLayer } from '../../files/__tests__/pdf-fixtures.js';

const CTX = { userId: 'u1', sessionId: 'sess-A', canDispatchMission: true };

interface Row {
  id: string;
  session_id: string;
  name: string;
  content_type: string;
  size: number;
  storage_key: string;
}

const stored = new Map<string, Buffer>();

vi.mock('../../storage/uploads.js', () => ({
  getObjectAtKey: async (key: string) => {
    const buffer = stored.get(key);
    return buffer ? { buffer, contentType: 'application/octet-stream' } : null;
  },
  isValidUploadId: (id: string) => /^(gen-)?\d+-[0-9a-f-]{36}\.[a-z]+$/i.test(id),
}));

/** `sessionImages` are ids this conversation contains but that have no chat_files row. */
function fakeDb(rows: Row[], sessionImages: string[] = []) {
  return {
    chatFiles: {
      async listBySessionAndIds(sessionId: string, ids: string[]) {
        return rows.filter((r) => r.session_id === sessionId && ids.includes(r.id));
      },
    },
    sessions: {
      async sessionReferencesImage(_sessionId: string, id: string) {
        return sessionImages.includes(id);
      },
    },
  } as unknown as DatabaseProvider;
}

function read(db: DatabaseProvider, input: Record<string, unknown>, ctx = CTX) {
  const t = createReadAttachmentTool(db, ctx) as unknown as {
    execute: (i: unknown) => Promise<Record<string, unknown>>;
  };
  return t.execute(input);
}

const csv: Row = {
  id: 'f1',
  session_id: 'sess-A',
  name: 'data.csv',
  content_type: 'text/csv',
  size: 12,
  storage_key: 'chat-files/u1/f1/data.csv',
};

beforeEach(() => {
  stored.set(csv.storage_key, Buffer.from('a,b\n1,2\n3,4\n'));
});
afterEach(() => stored.clear());

describe('read_attachment', () => {
  it('returns the text of a readable attachment', async () => {
    const res = await read(fakeDb([csv]), { file_id: 'f1' });
    expect(res.text).toBe('a,b\n1,2\n3,4\n');
    expect(res.truncated).toBe(false);
    expect(res.name).toBe('data.csv');
  });

  it('truncates past max_chars and says so', async () => {
    const res = await read(fakeDb([csv]), { file_id: 'f1', max_chars: 500 });
    expect(res.truncated).toBe(false);
    const short = await read(fakeDb([csv]), { file_id: 'f1', max_chars: 3 });
    expect(short.text).toBe('a,b');
    expect(short.truncated).toBe(true);
  });

  it('refuses a file from another conversation', async () => {
    const other = { ...csv, id: 'f2', session_id: 'sess-B' };
    const res = await read(fakeDb([other]), { file_id: 'f2' });
    expect(String(res.error)).toMatch(/no such attachment/);
    expect(res.text).toBeUndefined();
  });

  it('tells the model an image is an image, instead of denying it exists', async () => {
    // Images have no chat_files row by design, so the id resolved to nothing
    // and the tool said "no such attachment" — sending the model off to guess a
    // better id rather than to the tool that can actually see pictures.
    const imageId = '1786519724089-e49df116-2d16-4c86-b430-c2fbb61fb926.jpg';
    const res = await read(fakeDb([], [imageId]), { file_id: imageId });
    expect(String(res.error)).toMatch(/analyze_image/);
    expect(String(res.error)).not.toMatch(/no such attachment/);
  });

  it('still denies an image belonging to another conversation', async () => {
    const imageId = '1786519724089-e49df116-2d16-4c86-b430-c2fbb61fb926.jpg';
    const res = await read(fakeDb([], []), { file_id: imageId });
    expect(String(res.error)).toMatch(/no such attachment/);
  });

  it('reads a PDF that has a text layer', async () => {
    const pdf: Row = { ...csv, id: 'f3', name: 'terms.pdf', content_type: 'application/pdf' };
    stored.set(pdf.storage_key, pdfWithText('Payment terms are net 30 days'));
    const res = await read(fakeDb([pdf]), { file_id: 'f3' });
    expect(res.error).toBeUndefined();
    expect(String(res.text)).toContain('net 30 days');
  });

  it('refuses a scanned PDF by name, and does not send it to a sandbox that cannot OCR', async () => {
    const pdf: Row = { ...csv, id: 'f6', name: 'scan.pdf', content_type: 'application/pdf' };
    stored.set(pdf.storage_key, pdfWithoutTextLayer(2));
    const res = await read(fakeDb([pdf]), { file_id: 'f6' });
    // Naming the reason is the point: "no text layer" is what stops the model
    // retrying, and it must never come back as empty text.
    expect(String(res.error)).toMatch(/no usable text layer/);
    expect(res.text).toBeUndefined();
    // The agent-runtime image ships poppler but no OCR engine, so a mission
    // arrives at this same refusal after burning a container. The route that
    // works is a file with real text, or the pages as images.
    expect(String(res.error)).toMatch(/analyze_image/);
    expect(String(res.error)).not.toMatch(/Dispatch a mission/);
  });

  it('does not send a password-protected PDF to a sandbox that has no password either', async () => {
    const pdf: Row = { ...csv, id: 'f9', name: 'locked.pdf', content_type: 'application/pdf' };
    stored.set(pdf.storage_key, encryptedPdf());
    const res = await read(fakeDb([pdf]), { file_id: 'f9' });
    expect(String(res.error)).toMatch(/password-protected/);
    expect(String(res.error)).toMatch(/without password protection/);
    expect(String(res.error)).not.toMatch(/Dispatch a mission/);
  });

  it('refuses an unreadable format with a message that points at a mission', async () => {
    const clip: Row = { ...csv, id: 'f7', name: 'demo.mp4', content_type: 'video/mp4' };
    stored.set(clip.storage_key, Buffer.from([0x00, 0x01]));
    const res = await read(fakeDb([clip]), { file_id: 'f7' });
    expect(String(res.error)).toMatch(/not a format that can be read as text/);
    expect(String(res.error)).toMatch(/mission/);
  });

  it('refuses something too large to be worth a context window', async () => {
    const big: Row = { ...csv, id: 'f4', name: 'dump.txt', content_type: 'text/plain', size: 40 * 1024 * 1024 };
    const res = await read(fakeDb([big]), { file_id: 'f4' });
    expect(String(res.error)).toMatch(/too large to read here/);
    expect(String(res.error)).toMatch(/mission/);
  });

  it('does not name a sandbox the caller cannot reach', async () => {
    // `mission_dispatch` is behind a feature flag. Telling a user without it to
    // "dispatch a mission" named a tool the model could not see, leaving it with
    // a refusal and no route forward — an unreachable exit is worse than none.
    const clip: Row = { ...csv, id: 'f8', name: 'demo.mp4', content_type: 'video/mp4' };
    stored.set(clip.storage_key, Buffer.from([0x00, 0x01]));
    const res = await read(fakeDb([clip]), { file_id: 'f8' }, { ...CTX, canDispatchMission: false });
    expect(String(res.error)).toMatch(/not a format that can be read as text/);
    expect(String(res.error)).not.toMatch(/mission/i);
    expect(String(res.error)).toMatch(/no sandbox available/i);
  });

  it('reports missing bytes rather than pretending the file was empty', async () => {
    const ghost: Row = { ...csv, id: 'f5', storage_key: 'chat-files/u1/f5/gone.csv' };
    const res = await read(fakeDb([ghost]), { file_id: 'f5' });
    expect(String(res.error)).toMatch(/missing from storage/);
  });
});
