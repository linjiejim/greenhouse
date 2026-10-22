/**
 * Bounded MCP replies — storage, ownership, paging and expiry.
 *
 * The object store is replaced by an in-memory map with the same key contract,
 * so these tests pin what the module does with keys rather than COS or disk.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const objects = vi.hoisted(() => new Map<string, Buffer>());
const put = vi.hoisted(() => vi.fn(async (key: string, buffer: Buffer) => void objects.set(key, buffer)));
vi.mock('../../storage/uploads.js', () => ({
  toolOutputKeyPrefix: () => 'drive/mcp-output/',
  putObjectAtKey: put,
  getObjectAtKey: async (key: string) =>
    objects.has(key) ? { buffer: objects.get(key)!, contentType: 'application/json' } : null,
  deleteObjectAtKey: async (key: string) => void objects.delete(key),
  listObjectKeys: async (prefix: string) => [...objects.keys()].filter((key) => key.startsWith(prefix)),
}));

import {
  MCP_REPLY_MAX_CHARS,
  TOOL_OUTPUT_PREVIEW_CHARS,
  TOOL_OUTPUT_READ_MAX_CHARS,
  TOOL_OUTPUT_TTL_MS,
  ToolOutputNotFoundError,
  boundReplyText,
  previewBoundary,
  readToolOutput,
  sweepExpiredToolOutputs,
} from '../tool-output-store.js';

const alice = { userId: 'user-alice', clientId: 'client-codex' };
const SOURCE = 'knowledge_query';
const allowAll = () => true;

function bigJson(rows = 400): string {
  return JSON.stringify({
    rows: Array.from({ length: rows }, (_, i) => ({ id: i, title: `Row ${i}`, body: 'x'.repeat(60) })),
  });
}

beforeEach(() => objects.clear());

describe('boundReplyText', () => {
  it('passes a reply at or under the cap through untouched and stores nothing', async () => {
    const text = 'a'.repeat(MCP_REPLY_MAX_CHARS);
    const result = await boundReplyText(text, alice, SOURCE);
    expect(result).toEqual({ content: [{ type: 'text', text }], outputId: null });
    expect(objects.size).toBe(0);
  });

  it('stores an oversized reply and returns the handle first, then a preview cut at an element boundary', async () => {
    const text = bigJson();
    expect(text.length).toBeGreaterThan(MCP_REPLY_MAX_CHARS);
    const result = await boundReplyText(text, alice, SOURCE);

    expect(result.content).toHaveLength(2);
    const handle = JSON.parse(result.content[0]!.text);
    expect(handle).toMatchObject({ truncated: true, output_id: result.outputId, total_chars: text.length });
    expect(handle.output_id).toMatch(/^out_\d{13}_[0-9a-f]{32}$/);

    const preview = result.content[1]!.text;
    expect(text.startsWith(preview)).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_CHARS);
    expect(preview.endsWith('},')).toBe(true);
    expect(handle.next_offset).toBe(preview.length);
    // The whole reply stays bounded.
    expect(result.content.reduce((sum, block) => sum + block.text.length, 0)).toBeLessThan(MCP_REPLY_MAX_CHARS);
    expect(objects.size).toBe(1);
  });

  it('still answers, without a handle, when the store is unavailable', async () => {
    put.mockRejectedValueOnce(new Error('bucket down'));
    const result = await boundReplyText(bigJson(), alice, SOURCE);
    expect(JSON.parse(result.content[0]!.text)).toMatchObject({ truncated: true, output_id: null });
    expect(result.outputId).toBeNull();
  });
});

describe('previewBoundary', () => {
  it('prefers a line break, then an element end, and never splits a surrogate pair', () => {
    expect(previewBoundary(`${'a'.repeat(90)}\n${'b'.repeat(50)}`, 100)).toBe(91);
    expect(previewBoundary(`${'a'.repeat(85)}},{"b":"${'c'.repeat(40)}"}`, 100)).toBe(87);
    // No boundary in the last quarter and a pair straddling the cut: back off one unit.
    const text = `${'a'.repeat(99)}😀${'a'.repeat(10)}`;
    expect(previewBoundary(text, 100)).toBe(99);
  });
});

describe('readToolOutput', () => {
  it('pages through the stored text contiguously, for the producing member and client only', async () => {
    const text = bigJson(800);
    const { outputId } = await boundReplyText(text, alice, SOURCE);

    let offset = 0;
    let rebuilt = '';
    for (;;) {
      const page = await readToolOutput(alice, { outputId: outputId!, offset }, allowAll);
      expect(page.returned_chars).toBeLessThanOrEqual(TOOL_OUTPUT_READ_MAX_CHARS);
      expect(page.total_chars).toBe(text.length);
      rebuilt += page.text;
      if (page.next_offset === null) break;
      offset = page.next_offset;
    }
    expect(rebuilt).toBe(text);

    // Same member, other client — and other member, same client: both see nothing.
    await expect(
      readToolOutput({ ...alice, clientId: 'client-other' }, { outputId: outputId! }, allowAll),
    ).rejects.toThrow(ToolOutputNotFoundError);
    await expect(readToolOutput({ ...alice, userId: 'user-bob' }, { outputId: outputId! }, allowAll)).rejects.toThrow(
      ToolOutputNotFoundError,
    );
  });

  it('clamps the limit to the per-call maximum and the offset to the text', async () => {
    const text = bigJson(800);
    const { outputId } = await boundReplyText(text, alice, SOURCE);
    const page = await readToolOutput(alice, { outputId: outputId!, offset: 100, limit: 1_000_000 }, allowAll);
    expect(page.returned_chars).toBe(TOOL_OUTPUT_READ_MAX_CHARS);
    expect(page.text).toBe(text.slice(100, 100 + TOOL_OUTPUT_READ_MAX_CHARS));
    const tail = await readToolOutput(alice, { outputId: outputId!, offset: text.length + 50 }, allowAll);
    expect(tail).toMatchObject({ returned_chars: 0, next_offset: null });
  });

  it('refuses malformed and expired ids even before the sweep has run', async () => {
    const created = Date.now() - TOOL_OUTPUT_TTL_MS - 1000;
    const { outputId } = await boundReplyText(bigJson(), alice, SOURCE, created);
    await expect(readToolOutput(alice, { outputId: outputId! }, allowAll)).rejects.toThrow(ToolOutputNotFoundError);
    await expect(readToolOutput(alice, { outputId: '../../uploads/secret' }, allowAll)).rejects.toThrow(
      ToolOutputNotFoundError,
    );
  });
});

describe('sweepExpiredToolOutputs', () => {
  it('deletes outputs older than the TTL and leaves fresh ones and foreign keys alone', async () => {
    const now = Date.now();
    const old = await boundReplyText(bigJson(), alice, SOURCE, now - TOOL_OUTPUT_TTL_MS - 1);
    const fresh = await boundReplyText(bigJson(), alice, SOURCE, now - 1000);
    objects.set('drive/mcp-output/not-ours.json', Buffer.from('{}'));

    expect(await sweepExpiredToolOutputs(now)).toBe(1);
    expect([...objects.keys()].some((key) => key.includes(old.outputId!))).toBe(false);
    expect([...objects.keys()].some((key) => key.includes(fresh.outputId!))).toBe(true);
    expect(objects.has('drive/mcp-output/not-ours.json')).toBe(true);
  });
});

describe('readToolOutput after permissions change', () => {
  it('stops paging an output once the tool that produced it is no longer allowed', async () => {
    const { outputId } = await boundReplyText(bigJson(), alice, 'tables_query');
    const allowed = new Set(['tables_query', 'knowledge_query']);
    const canUse = (tool: string) => allowed.has(tool);
    await expect(readToolOutput(alice, { outputId: outputId! }, canUse)).resolves.toMatchObject({ offset: 0 });
    allowed.delete('tables_query');
    await expect(readToolOutput(alice, { outputId: outputId! }, canUse)).rejects.toThrow(ToolOutputNotFoundError);
  });

  it('never starts a range on the second half of an emoji', async () => {
    const text = '😀'.repeat(MCP_REPLY_MAX_CHARS);
    const { outputId } = await boundReplyText(text, alice, SOURCE);
    const page = await readToolOutput(alice, { outputId: outputId!, offset: 1, limit: 2 }, allowAll);
    expect(page.offset).toBe(0);
    expect(page.text).toBe('😀');
  });
});
