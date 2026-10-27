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
