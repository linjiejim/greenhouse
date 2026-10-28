import { describe, expect, it } from 'vitest';
import { parseManifest, PENDING_MANIFEST } from './manifest';
import { pluginEntityLink } from './entity-links';

const manifest = parseManifest({
  manifest_version: 2,
  core: { version: '4.0.0', client_api: 4 },
  plugins: [
    {
      id: 'crm',
      nav: [],
      entities: [{ id: 'crm.company', kind: 'ext:crm:company' }],
      entity_kinds: [
        { kind: 'ext:crm:company', route: '#/crm/companies/:id' },
        { kind: 'ext:crm:gone', route: '#/crm/gone/:id' },
      ],
      pages: [
        { id: 'crm-company', kind: 'entity-list', entity: 'crm.company' },
        { id: 'crm-company-detail', kind: 'entity-detail', entity: 'crm.company' },
      ],
    },
    {
      id: 'notes',
      nav: [],
      entities: [{ id: 'notes.note', kind: 'ext:notes:note' }],
      entity_kinds: [{ kind: 'ext:notes:note', route: '#/notes?note=:id' }],
      pages: [{ id: 'notes-note', kind: 'entity-list', entity: 'notes.note' }],
    },
  ],
});

describe('plugin record links', () => {
  it('opens the record a plugin route template names', () => {
    expect(pluginEntityLink(manifest, '#/crm/companies/42')).toEqual({
      plugin: 'crm',
      page: 'crm-company-detail',
      entity: 'crm.company',
      id: '42',
    });
    expect(pluginEntityLink(manifest, '#/notes?note=rec_1')).toEqual({
      plugin: 'notes',
      page: 'notes-note',
      entity: 'notes.note',
      id: 'rec_1',
    });
  });

  it('names nothing for lists, other addresses, kinds without an entity, or before discovery', () => {
    expect(pluginEntityLink(manifest, '#/crm/companies')).toBeNull();
    expect(pluginEntityLink(manifest, '#/crm/companies/42/edit')).toBeNull();
    expect(pluginEntityLink(manifest, '#/crm/gone/1')).toBeNull();
    expect(pluginEntityLink(manifest, '#/crm/companies/%E0')).toBeNull();
    expect(pluginEntityLink(manifest, '#/notes')).toBeNull();
    expect(pluginEntityLink(PENDING_MANIFEST, '#/crm/companies/42')).toBeNull();
  });
});
