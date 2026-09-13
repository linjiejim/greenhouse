/**
 * How `analyze_image` reads the reference the model gave it.
 *
 * `generate_image` hands back both `id` and `url`, so the model passes either.
 * The URL form reached `getUpload` verbatim and came back "Invalid upload ID" —
 * which the model reports as "that image does not exist" for an image sitting
 * in the transcript. Same normalization as attachments (`normalizeFileRef`).
 *
 * The second store matters just as much: a composer with a skill or mission
 * selected routes every picked file to `chat_files`, images included, so the id
 * the model is handed can be a bare UUID that never existed in the upload
 * space. That hit `getUpload`'s throw and surfaced as "Failed to load image:
 * Invalid upload ID" — a dead end for a file this conversation really owns
 * (dev, 2026-08-20, a scanned W-9 the model tried to read as an image).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';

const getUpload = vi.fn();
const resolveConversationFiles = vi.fn();

vi.mock('../../storage/uploads.js', async () => {
  // `isValidUploadId` is the real thing: the guard order it enforces is exactly
  // what this file is testing, so stubbing it would test nothing.
  const actual = await vi.importActual<typeof import('../../storage/uploads.js')>('../../storage/uploads.js');
  return { isValidUploadId: actual.isValidUploadId, getUpload: (id: string) => getUpload(id) };
});

vi.mock('../../files/conversation-files.js', async () => {
  const actual = await vi.importActual<typeof import('../../files/conversation-files.js')>(
    '../../files/conversation-files.js',
  );
  return {
    normalizeFileRef: actual.normalizeFileRef,
    resolveConversationFiles: (...args: unknown[]) => resolveConversationFiles(...args),
  };
});

const { createAnalyzeImageTool } = await import('../analyze-image.js');

async function analyze(imageId: string, ctx: { sessionId?: string } = {}) {
  const tool = createAnalyzeImageTool({ db: {} as DatabaseProvider, userId: 'u1', ...ctx });
  // The AI SDK types `execute` as optional; it is always present on our tools.
  return (await tool.execute!({ image_id: imageId } as never, { toolCallId: 't1', messages: [] })) as Record<
    string,
    unknown
  >;
}

/** A resolved conversation file, shaped as `resolveConversationFiles` returns it. */
function conversationFile(overrides: Partial<{ name: string; content_type: string; bytes: Buffer | null }> = {}) {
  const { name = 'photo.png', content_type = 'image/png', bytes = Buffer.from('png-bytes') } = overrides;
  return {
    ok: true as const,
    files: [{ ref: 'r', name, content_type, size: 10, read: async () => bytes }],
  };
}

describe('analyze_image reference normalization', () => {
  beforeEach(() => {
    getUpload.mockReset();
    getUpload.mockResolvedValue(null);
    resolveConversationFiles.mockReset();
    resolveConversationFiles.mockResolvedValue({ ok: false, missing: ['r'] });
  });

  it('accepts the /api/upload/<id> URL generate_image returns', async () => {
    await analyze('/api/upload/gen-1754900000000-bf1b54d2-0181-45b2-8131-2c0000000000.png');

    expect(getUpload).toHaveBeenCalledWith('gen-1754900000000-bf1b54d2-0181-45b2-8131-2c0000000000.png');
  });

  it('leaves a bare upload id alone', async () => {
    await analyze('1754900000000-bf1b54d2-0181-45b2-8131-2c0000000000.png');

    expect(getUpload).toHaveBeenCalledWith('1754900000000-bf1b54d2-0181-45b2-8131-2c0000000000.png');
  });

  it('quotes the reference it was given when nothing resolves', async () => {
    const result = await analyze('nope.png');

    expect(result.error).toContain('"nope.png"');
  });

  it('never sends a non-upload id to the storage layer', async () => {
    // `getUpload` throws for these; that throw was the "Invalid upload ID" leak.
    await analyze('c42a1e63-50ed-4820-8f6b-ab1fb11d861c', { sessionId: 's1' });

    expect(getUpload).not.toHaveBeenCalled();
  });

  it('analyzes an image that landed in chat_files instead of the upload store', async () => {
    resolveConversationFiles.mockResolvedValue(conversationFile());

    const result = await analyze('c42a1e63-50ed-4820-8f6b-ab1fb11d861c', { sessionId: 's1' });

    expect(resolveConversationFiles).toHaveBeenCalledWith({}, 's1', ['c42a1e63-50ed-4820-8f6b-ab1fb11d861c']);
    // It got past resolution — the failure now comes from the vision provider,
    // not from the reference.
    expect(result.error).not.toContain('Invalid upload ID');
    expect(result.error).not.toContain('Image not found');
  });

  it('names the file and its type when the attachment is not an image', async () => {
    resolveConversationFiles.mockResolvedValue(conversationFile({ name: 'w9.pdf', content_type: 'application/pdf' }));

    const result = await analyze('c42a1e63-50ed-4820-8f6b-ab1fb11d861c', { sessionId: 's1' });

    expect(result.error).toContain('"w9.pdf"');
    expect(result.error).toContain('"application/pdf"');
    expect(result.error).toContain('read_attachment');
    expect(result.error).not.toContain('Invalid upload ID');
  });

  it('does not reach for the conversation when there is no session', async () => {
    // Stateless proxy/MCP callers have no conversation to be scoped to.
    const result = await analyze('c42a1e63-50ed-4820-8f6b-ab1fb11d861c');

    expect(resolveConversationFiles).not.toHaveBeenCalled();
    expect(result.error).toContain('Image not found');
  });
});
