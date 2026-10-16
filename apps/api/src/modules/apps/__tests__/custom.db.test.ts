import { describe, expect, it } from 'vitest';
import { createTestApp } from '../../../testing.js';

describe('reviewed custom cards', () => {
  it('approves an exact published version, scopes bindings, and does not carry approval to the next version', async () => {
    const app = createTestApp();
    const admin = await app.member('admin');
    const member = await app.member();
    const tables = app.services.tables;
    const apps = app.services.apps;
    const base = await tables.create(member.id, { name: 'Cards' });
    const table = base.tables[0]!;
    const draft = await apps.create(member.id, { base_id: base.id, name: 'Custom', description: '' });
    const saved = await apps.save(member.id, draft.app.id, {
      revision: draft.revision,
      name: 'Custom',
      description: '',
      spec: {
        roles: [],
        pages: [
          {
            id: 'home',
            name: 'Home',
            cards: [
              { id: 'count', kind: 'number', title: 'Count', table_id: table.id, measure: { aggregate: 'count' } },
              {
                id: 'code',
                kind: 'custom',
                title: 'Code',
                html: '<p>reviewed source</p>',
                bindings: [{ id: 'count', card: 'count' }],
              },
            ],
          },
        ],
      },
    });
    const published = await apps.publish(member.id, draft.app.id, {
      revision: saved.revision,
      notes: '',
      audience: [],
    });
    const version = (await apps.versions(member.id, draft.app.id, { limit: 10 })).items[0]!;
    expect(JSON.stringify((await apps.runtime(member.id, draft.app.id)).pages)).not.toContain('reviewed source');
    await expect(
      apps.binding(member.id, draft.app.id, { version: 1, card: 'code', binding: 'count' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      apps.review(member.id, draft.app.id, { version: 1, spec_hash: version.spec_hash, decision: 'approved' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      apps.review(admin.id, draft.app.id, { version: 1, spec_hash: '0'.repeat(64), decision: 'approved' }),
    ).rejects.toMatchObject({ code: 'stale_version' });
    await apps.review(admin.id, draft.app.id, { version: 1, spec_hash: version.spec_hash, decision: 'approved' });
    expect(JSON.stringify((await apps.runtime(member.id, draft.app.id)).pages)).toContain('reviewed source');
    expect(await apps.binding(member.id, draft.app.id, { version: 1, card: 'code', binding: 'count' })).toMatchObject({
      kind: 'chart',
      data: { value: 0 },
    });
    await expect(
      apps.binding(member.id, draft.app.id, { version: 1, card: 'code', binding: 'other' }),
    ).rejects.toMatchObject({ status: 404 });
    await apps.publish(member.id, draft.app.id, { revision: published.revision, notes: '', audience: [] });
    expect((await apps.runtime(member.id, draft.app.id)).custom_review).toBe('pending');
    expect(JSON.stringify((await apps.runtime(member.id, draft.app.id)).pages)).not.toContain('reviewed source');
    await expect(
      apps.binding(member.id, draft.app.id, { version: 1, card: 'code', binding: 'count' }),
    ).rejects.toMatchObject({ code: 'stale_version' });
  });
});
