import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';

const storage = vi.hoisted(() => ({
  putObjectAtKey: vi.fn(),
  deleteObjectAtKey: vi.fn(),
  chatFileKeyFor: vi.fn(() => 'drive/chat/generated.csv'),
}));

vi.mock('../storage/uploads.js', () => storage);

import { createExportDataTool } from './export-data.js';

async function execute(tool: ReturnType<typeof createExportDataTool>, input: unknown) {
  return (await tool.execute!(input as never, {
    toolCallId: 'export-data-test',
    messages: [],
  })) as unknown as Record<string, unknown>;
}

describe('export_data inline source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storage.putObjectAtKey.mockResolvedValue(undefined);
    storage.deleteObjectAtKey.mockResolvedValue(undefined);
  });

  it('persists a generic CSV artifact without a domain-specific export action', async () => {
    const create = vi.fn(async (input) => ({ id: 'file-1', ...input }));
    const db = { chatFiles: { create } } as unknown as DatabaseProvider;
    const result = await execute(createExportDataTool(db, { userId: 'user-1', sessionId: 'session-1' }), {
      source: {
        type: 'inline',
        columns: [
          { key: 'region', label: '区域' },
          { key: 'amount', label: '金额' },
        ],
        rows: [{ region: '华东', amount: 42 }],
      },
      format: 'csv',
      filename: '../quarterly:report.xlsx',
    });

    expect(result).toMatchObject({
      type: 'file',
      file_id: 'file-1',
      name: '..-quarterly-report.csv',
      row_count: 1,
      download_url: '/api/chat-files/file-1/content',
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: 'session-1',
        created_by: 'user-1',
        storage_key: 'drive/chat/generated.csv',
      }),
    );
    const buffer = storage.putObjectAtKey.mock.calls[0]![1] as Buffer;
    expect(buffer.toString('utf8')).toContain('"区域","金额"');
    expect(buffer.toString('utf8')).toContain('"华东","42"');
  });

  it('removes the object when metadata persistence fails', async () => {
    const db = {
      chatFiles: {
        create: vi.fn(async () => {
          throw new Error('database unavailable');
        }),
      },
    } as unknown as DatabaseProvider;

    const result = await execute(createExportDataTool(db, { userId: 'user-1', sessionId: 'session-1' }), {
      source: { type: 'inline', rows: [{ id: 1 }] },
      format: 'csv',
    });

    expect(result).toEqual({ error: 'Export failed: database unavailable' });
    expect(storage.deleteObjectAtKey).toHaveBeenCalledWith('drive/chat/generated.csv');
  });
});
