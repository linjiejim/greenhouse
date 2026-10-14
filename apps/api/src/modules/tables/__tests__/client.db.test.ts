/** The typed client's tables calls against the real app, and the answers checked against the contract. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  baseAuditEntrySchema,
  baseSchema,
  baseSharesSchema,
  baseSummarySchema,
  baseTableSchema,
  bulkResultSchema,
  commentSchema,
  fieldSchema,
  pageSchema,
  recordActivitySchema,
  recordDetailSchema,
  recordFileSchema,
  recordPageSchema,
  recordSchema,
  recordTitleSchema,
  trashItemSchema,
  viewSchema,
  type TokenPair,
} from '@greenhouse/contract';
import { ApiClientError, createApiClient } from '@greenhouse/contract/client';
import { z } from 'zod';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';

describe('client.tables', () => {
  it('covers bases, tables, fields, views, records, comments, sharing, the bin, files and export', async () => {
    const { app, member } = createTestApp({
      STORAGE_PROVIDER: 'local',
      STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-tables-client-')),
    });
    await member('member', 'lin@example.com');
    const mei = await member('member', 'mei@example.com');
    let stored: TokenPair | null = null;
    const client = createApiClient({
      baseUrl: '',
      tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
      fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
    });
    await client.auth.login('lin@example.com', TEST_PASSWORD);
    const { tables } = client;

    const base = baseSchema.parse(await tables.bases.create({ template: 'project' }));
    z.object({ items: z.array(baseSummarySchema) }).parse(await tables.bases.list());
    baseSchema.parse(await tables.bases.update(base.id, { pinned: true }));
    const tasks = base.tables[1]!;
    const title = tasks.fields[0]!;

    const extra = baseTableSchema.parse(await tables.bases.createTable(base.id, 'Notes'));
    baseTableSchema.parse(await tables.tables.update(extra.id, { description: 'Loose ends' }));
    const field = fieldSchema.parse(await tables.tables.createField(extra.id, { name: 'Done', type: 'checkbox' }));
    fieldSchema.parse(await tables.fields.update(field.id, { name: 'Finished' }));
    const view = viewSchema.parse(
      await tables.tables.createView(extra.id, { name: 'Mine', type: 'grid', personal: true }),
    );
    viewSchema.parse(await tables.views.update(view.id, { revision: view.revision, config: { row_height: 'tall' } }));
    await tables.views.remove(view.id);

    const page = recordPageSchema.parse(await tables.tables.query(tasks.id, { limit: 3, count: true }));
    expect(page.total).toBe(9);
    const first = page.items[0]!;
    const changed = recordDetailSchema.parse(
      await tables.records.update(first.id, first.revision, { [title.id]: 'Renamed' }),
    );
    await expect(tables.records.update(first.id, first.revision, { [title.id]: 'Late' })).rejects.toMatchObject({
      status: 409,
      code: 'stale_revision',
    } satisfies Partial<ApiClientError>);
    recordDetailSchema.parse(await tables.records.get(first.id));
    const made = recordDetailSchema.parse(
      await tables.tables.createRecord(tasks.id, { values: { [title.id]: 'New' } }),
    );
    bulkResultSchema.parse(
      await tables.tables.bulk(tasks.id, {
        items: [{ id: made.record.id, revision: made.record.revision, values: { [title.id]: 'Newer' } }],
      }),
    );
    z.object({ items: z.array(recordTitleSchema) }).parse(await tables.tables.titles(tasks.id, { q: 'New' }));
    commentSchema.parse(await tables.records.comment(changed.record.id, 'First'));
    recordActivitySchema.parse(await tables.records.activity(changed.record.id));

    await tables.records.remove(made.record.id);
    expect(await tables.tables.deleteRecords(tasks.id, [page.items[1]!.id])).toEqual({ deleted: 1 });
    pageSchema(trashItemSchema).parse(await tables.bases.trash(base.id));
    recordSchema.parse(await tables.records.restore(made.record.id));
    await tables.records.purge(page.items[1]!.id);
    await tables.fields.archive(field.id);
    fieldSchema.parse(await tables.fields.restore(field.id));
    await tables.tables.archive(extra.id);
    baseTableSchema.parse(await tables.tables.restore(extra.id));

    baseSharesSchema.parse(
      await tables.bases.share(base.id, { items: [{ type: 'member', id: mei.id, role: 'viewer' }] }),
    );
    baseSharesSchema.parse(await tables.bases.shares(base.id));
    pageSchema(baseAuditEntrySchema).parse(await tables.bases.audit(base.id));
    recordFileSchema.parse(await tables.bases.upload(base.id, new File(['a,b'], 'data.csv', { type: 'text/csv' })));

    const csv = await tables.tables.export(tasks.id, base.views.find((entry) => entry.table_id === tasks.id)!.id);
    expect(csv.filename).toMatch(/^任务-\d{4}-\d{2}-\d{2}\.csv$/);
    expect((await csv.blob.text()).split('\r\n')[0]).toContain('名称');

    baseSchema.parse(await tables.bases.archive(base.id));
    baseSchema.parse(await tables.bases.restore(base.id));
    await tables.bases.remove(base.id, base.name);
    await expect(tables.bases.get(base.id)).rejects.toMatchObject({ status: 404 });
  });
});
