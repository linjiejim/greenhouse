import { describe, expect, it } from 'vitest';
import { defineApp } from '@greenhouse/platform-kernel';
import { defineExtension } from '../define.js';

export const fixture = () =>
  defineExtension({
    id: 'fixture',
    name: 'Fixture',
    sdk: 2,
    dataSources: [
      {
        app: defineApp({
          id: 'fixture',
          title: 'Fixture',
          version: '1.0.0',
          modules: { note: { title: 'Notes' } },
          actions: {},
          entities: {
            note: {
              title: 'Note',
              module: 'note',
              table: 'ext_fixture_notes',
              accessScopes: ['own'],
              fields: {
                id: { kind: 'text', title: 'ID' },
                title: { kind: 'text', title: 'Title', searchable: true, sortable: true, filterable: true },
                owner: { kind: 'user', title: 'Owner', classification: 'internal' },
              },
            },
          },
        }),
        entities: {
          note: {
            actions: { read: 'team', create: 'team', update: 'team', delete: 'super', export: 'team' },
            ownerField: 'owner',
            peek: { title: 'title' },
          },
        },
      },
    ],
  });
describe('SDK 2 data plugins', () => {
  it('derives the existing application, tool, REST, search, export and entity registries', () => {
    const ext = fixture();
    expect(ext.applications?.[0].teamCapabilities).toEqual(
      expect.arrayContaining(['fixture.note.read', 'fixture.note.create', 'fixture.note.export']),
    );
    expect(ext.applications?.[0].teamCapabilities).not.toContain('fixture.note.delete');
    expect(ext.tools?.map((t) => t.meta.id)).toEqual(['fixture_query', 'fixture_mutation']);
    expect(ext.tools?.[1].meta.surface?.proxy).toBe('write');
    expect(ext.applications?.[0].teamFieldPolicies?.note.owner.write).toBe(false);
    expect(ext.applications?.[0].teamFieldPolicies?.note.title.write).toBe(true);
    expect(ext.tools?.[0].meta.description).toContain('Note');
    expect(ext.featurePoints?.[0]).toMatchObject({ kind: 'app', appId: 'fixture' });
    expect(ext.routes?.[0].path).toBe('/api/ext/fixture/entities/note');
    expect(ext.mcpGroups).toEqual(['fixture']);
    expect(ext.entityKinds?.[0]).toEqual({ kind: 'ext:fixture:note', route: '#/ext/fixture/note/:id' });
    expect(ext.searchSources).toHaveLength(1);
    expect(ext.exportSources).toHaveLength(1);
    expect(ext.catalogSources).toHaveLength(1);
    expect(ext.surfaces?.pages).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'entity-list', entity: 'fixture.note' })]),
    );
  });
});

it('omits mutation for read-only data, retains classification and rejects incomplete scope declarations', () => {
  const declaration = fixture().dataSources![0];
  const readOnly = defineExtension({
    id: 'readonly',
    name: 'Read only',
    dataSources: [{ ...declaration, entities: { note: { ...declaration.entities.note, actions: { read: 'team' } } } }],
  });
  expect(readOnly.tools?.map((tool) => tool.meta.id)).toEqual(['readonly_query']);
  expect(readOnly.applications?.[0].manifest.entities.note.fields.owner.classification).toBe('internal');
  expect(() =>
    defineExtension({
      id: 'invalid',
      name: 'Invalid',
      dataSources: [{ ...declaration, entities: { note: { ...declaration.entities.note, ownerField: undefined } } }],
    }),
  ).toThrow(/ownerField/);
});
