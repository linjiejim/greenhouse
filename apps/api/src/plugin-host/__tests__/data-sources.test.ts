import { describe, expect, it } from 'vitest';
import { defineExtension } from '../define.js';
import { fixture } from './data-source-fixture.js';

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
    // browser fallbacks are the universal client's plugin pages, never classic hash routes
    expect(ext.surfaces?.pages?.map((page) => page.fallback_url)).toEqual([
      '/p/fixture/fixture-note',
      '/p/fixture/fixture-note',
    ]);
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
