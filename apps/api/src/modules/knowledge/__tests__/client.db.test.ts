/** The typed client's knowledge calls against the real app, and the answers checked against the contract. */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  docDiffSchema,
  docVersionDetailSchema,
  knowledgeDocSchema,
  knowledgeFileSchema,
  knowledgeFolderSchema,
  knowledgeSearchResultSchema,
  knowledgeSharesSchema,
  pageSchema,
  commentSchema,
  docPresenceListSchema,
  knowledgeItemPageSchema,
  knowledgeItemSchema,
  type TokenPair,
} from '@greenhouse/contract';
import { ApiClientError, createApiClient } from '@greenhouse/contract/client';
import { createTestApp, TEST_PASSWORD } from '../../../testing.js';

describe('client.knowledge', () => {
  it('covers the tree, docs, versions, comments, shares, presence, files, export and search', async () => {
    const { app, member } = createTestApp({
      STORAGE_PROVIDER: 'local',
      STORAGE_ROOT: mkdtempSync(join(tmpdir(), 'gh-knowledge-client-')),
    });
    const lin = await member('member', 'lin@example.com');
    const chen = await member('member', 'chen@example.com');
    let stored: TokenPair | null = null;
    const client = createApiClient({
      baseUrl: '',
      tokens: { get: () => stored, set: (tokens) => (stored = tokens) },
      fetch: (input, init) => Promise.resolve(app.request(String(input), init)),
    });
    await client.auth.login('lin@example.com', TEST_PASSWORD);
    const { knowledge } = client;

    const folder = knowledgeFolderSchema.parse(await knowledge.folders.create({ name: 'Guides' }));
    const doc = knowledgeDocSchema.parse(
      await knowledge.docs.create({ title: 'Setup', content: 'Install it.', folder_id: folder.id }),
    );
    knowledgeItemPageSchema.parse(await knowledge.folders.roots('personal', { limit: 10 }));
    knowledgeFolderSchema.parse(await knowledge.folders.get(folder.id));
    const saved = knowledgeDocSchema.parse(
      await knowledge.docs.update(doc.id, { version: doc.version, content: 'Install it, then run it.' }),
    );
    await expect(knowledge.docs.update(doc.id, { version: 1, content: 'stale' })).rejects.toMatchObject({
      status: 409,
      code: 'stale_version',
    } satisfies Partial<ApiClientError>);
    pageSchema(knowledgeItemSchema).parse(await knowledge.docs.list({ space: 'personal' }));
    expect((await knowledge.docs.versions(doc.id)).items.map((version) => version.version)).toEqual([2, 1]);
    docVersionDetailSchema.parse(await knowledge.docs.version(doc.id, 1));
    docDiffSchema.parse(await knowledge.docs.diff(doc.id, { mode: 'word' }));
    knowledgeDocSchema.parse(await knowledge.docs.restoreVersion(doc.id, 1, saved.version));
    commentSchema.parse(await knowledge.docs.comment(doc.id, 'Nice.'));
    pageSchema(commentSchema).parse(await knowledge.docs.comments(doc.id));
    knowledgeSharesSchema.parse(
      await knowledge.folders.share(folder.id, { items: [{ type: 'member', id: chen.id, role: 'viewer' }] }),
    );
    docPresenceListSchema.parse(await knowledge.docs.beat(doc.id, 'editing'));
    await knowledge.docs.leave(doc.id);
    expect((await knowledge.docs.backlinks(doc.id)).items).toEqual([]);

    const file = knowledgeFileSchema.parse(
      await knowledge.files.upload(new File(['hello'], 'notes.txt', { type: 'text/plain' }), { folder_id: folder.id }),
    );
    expect(file.preview).toBe('text');
    knowledgeFileSchema.parse(await knowledge.files.update(file.id, { name: 'hello.txt' }));

    const exported = await knowledge.docs.export(doc.id);
    expect(exported).toEqual({ filename: 'Setup.md', markdown: '# Setup\n\nInstall it.\n' });
    const archive = await knowledge.folders.export(folder.id);
    expect(archive.filename).toMatch(/^Guides-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(Object.keys(unzipSync(new Uint8Array(await archive.blob.arrayBuffer()))).sort()).toEqual([
      'README.md',
      'Setup.md',
      'hello.txt',
    ]);
    knowledgeSearchResultSchema.parse(await knowledge.search({ q: 'install' }));

    await knowledge.docs.archive(doc.id);
    const archived = knowledgeItemPageSchema.parse(await knowledge.archived('personal'));
    expect(archived.items.map((item) => item.id)).toEqual([doc.id]);
    knowledgeDocSchema.parse(await knowledge.docs.restore(doc.id));
    await knowledge.reorder({ folder_id: folder.id, items: [{ type: 'file', id: file.id }] });
    expect((await knowledge.folders.get(folder.id)).children.map((item) => item.name)).toEqual(['hello.txt', 'Setup']);
    expect(lin.id).toBeTruthy();
  });
});
