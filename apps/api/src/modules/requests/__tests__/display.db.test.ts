import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getDb, members, newId, requests } from '@greenhouse/db';
import { cardBody } from '../../../../../mobile/src/requests/model.js';
import { createTestApp } from '../../../testing.js';
import { toRequest } from '../service.js';

const rawId = /\b[a-z]{3}_[0-9A-HJKMNP-TV-Z]{6,26}\b/;

describe('request display references', () => {
  it.each(['zh', 'en'] as const)(
    'names references in every domain and preserves executable ids (%s)',
    async (locale) => {
      const app = createTestApp();
      const lin = await app.member();
      const mei = await app.member();
      await getDb().update(members).set({ locale }).where(eq(members.id, lin.id));
      const { knowledge, tables, apps } = app.services;
      const folder = await knowledge.createFolder(lin.id, { name: 'Shared notes', space: 'team' });
      const doc = await knowledge.createDoc(lin.id, { title: 'Delivery plan', content: 'Ready', folder_id: folder.id });
      const hidden = await knowledge.createDoc(mei.id, { title: 'Mei private title', content: 'Private' });
      const base = await tables.create(lin.id, { name: 'Delivery' });
      const table = base.tables[0]!;
      const field = table.fields[0]!;
      const { record } = await tables.records.create(lin.id, table.id, { [field.id]: 'Ship v2' });
      const secret = await tables.createField(lin.id, table.id, { name: 'Hidden from app', type: 'text' });
      const created = await apps.create(lin.id, { base_id: base.id, name: 'Delivery desk', description: '' });
      const draft = await apps.save(lin.id, created.app.id, {
        revision: created.revision,
        name: 'Delivery desk',
        description: '',
        spec: {
          roles: [],
          pages: [
            {
              id: 'home',
              name: 'Home',
              cards: [
                {
                  id: 'add',
                  kind: 'button',
                  title: 'Add',
                  table_id: table.id,
                  action: { id: 'create', name: 'Create', type: 'create', values: { [field.id]: 'Ship v2' } },
                },
              ],
            },
          ],
        },
      });
      await apps.publish(lin.id, draft.app.id, { revision: draft.revision, notes: 'Ready', audience: [] });
      const ids = [
        folder.id,
        doc.id,
        base.id,
        table.id,
        field.id,
        record.id,
        draft.app.id,
        hidden.id,
        secret.id,
        newId('folder'),
      ];
      const value = ids.join(' | ');
      for (const tool of ['knowledge_mutation', 'table_mutation', 'table_schema', 'apps_action', 'mail', 'mcp_call']) {
        const input = {
          references: ids,
          values: { [field.id]: folder.id },
          ...(tool === 'apps_action' ? { app_id: draft.app.id, version: 1, card: 'add', action: 'create' } : {}),
        };
        const scope = { type: 'folder', id: folder.id, actions: ['create'] };
        const saved = await app.services.requests.create({
          memberId: lin.id,
          kind: 'approval',
          subject: 'tool_write',
          title: `Review ${doc.id}`,
          payload: {
            tool,
            input,
            standing_scope: scope,
            summary: `Change ${folder.id}`,
            details: [{ label: field.id, value }],
          },
        });
        expect(saved.payload.input).toEqual(input);
        expect(saved.payload.standing_scope).toEqual(scope);
        expect(saved.payload.details).toEqual([
          { label: field.name, value: expect.stringContaining('Shared notes / Delivery plan') },
        ]);
        const display = JSON.stringify({
          title: saved.payload.title,
          summary: saved.payload.summary,
          details: saved.payload.details,
        });
        expect(display).not.toMatch(rawId);
        expect(display).toContain('Delivery /');
        expect(display).toContain('Ship v2');
        expect(display).toContain('Delivery desk');
        if (tool === 'apps_action') expect(display).not.toContain(secret.name);
        expect(display).not.toContain(hidden.title);
        expect(display).toContain(locale === 'en' ? 'Unavailable object' : '不可用的对象');
        // The native request sheet consumes these same ordered details, with no id fallback.
        expect(cardBody(toRequest(saved)).details).toEqual(saved.payload.details);
      }
      const stored = await getDb().select().from(requests).where(eq(requests.memberId, lin.id));
      for (const row of stored) expect(JSON.stringify([row.payload.summary, row.payload.details])).not.toMatch(rawId);
    },
  );

  it('keeps private names out of room headings and summaries', async () => {
    const app = createTestApp();
    const lin = await app.member();
    const mei = await app.member();
    const room = await app.services.conversations.create(lin.id, {
      kind: 'room',
      agent_ids: [],
      member_ids: [mei.id],
      title: 'Delivery',
    });
    const doc = await app.services.knowledge.createDoc(lin.id, { title: 'Private plan', content: 'Private' });
    const saved = await app.services.requests.create({
      memberId: lin.id,
      conversationId: room.id,
      kind: 'approval',
      subject: 'tool_write',
      title: `Review ${doc.id}`,
      payload: { summary: `Edit ${doc.id}`, details: [{ label: 'Doc', value: doc.id }] },
    });
    expect(saved.payload.title).not.toContain(doc.title);
    expect(saved.payload.summary).not.toContain(doc.title);
    expect(saved.payload.details).toEqual([{ label: 'Doc', value: doc.title }]);
  });
});
