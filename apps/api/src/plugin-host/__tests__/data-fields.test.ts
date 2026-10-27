import { expect, it } from 'vitest';
import type { EntityDefinition } from '@greenhouse/platform-kernel';
import { dataWritableFields } from '../data-fields.js';

it('intersects declarations with member policy, preserving immutable storage fields even under broad grants', () => {
  const entity: EntityDefinition = {
    title: 'Record',
    module: 'record',
    table: 'records',
    accessScopes: ['all'],
    fields: {
      id: { kind: 'text', title: 'ID', writable: true },
      title: { kind: 'text', title: 'Title' },
      locked: { kind: 'text', title: 'Locked', writable: false },
      owner: { kind: 'user', title: 'Owner' },
      members: { kind: 'users', title: 'Members', writable: true },
      createdAt: { kind: 'dateTime', title: 'Created', writable: true },
      stamp: { kind: 'dateTime', title: 'Updated', writable: true },
      due: { kind: 'dateTime', title: 'Due' },
      internal: { kind: 'text', title: 'Internal', classification: 'internal', writable: true },
      restricted: { kind: 'text', title: 'Restricted', classification: 'restricted', writable: true },
      secret: { kind: 'text', title: 'Secret', classification: 'confidential', writable: true },
    },
  };
  const config = {
    actions: {},
    ownerField: 'owner',
    memberField: 'members',
    columns: { stamp: 'updated_at' },
    peek: { title: 'title' },
  };
  const policy = {
    scopes: [{ kind: 'all' as const }],
    fields: Object.fromEntries(
      Object.keys(entity.fields).map((key) => [key, { read: 'full' as const, write: true, export: true }]),
    ),
  };
  expect(dataWritableFields(entity, config, policy)).toEqual(['title', 'members', 'due']);
  entity.fields.owner.writable = true;
  policy.fields.members.write = false;
  expect(dataWritableFields(entity, config, policy)).toEqual(['title', 'owner', 'due']);
});
