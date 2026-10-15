import { expect, it } from 'vitest';
import { defineWebExtension } from '../define';
import { registerWebExtensions, WEB_EXTENSIONS } from '../registry';

it('validates Web registrations without importing any extension implementation into the host', () => {
  expect(() => defineWebExtension({ id: '../core' })).toThrow();
  const page = { id: 'notes', label: { zh: '笔记', en: 'Notes' }, component: () => null };
  expect(() => defineWebExtension({ id: 'example', pages: [page, page] })).toThrow();
  expect(() => defineWebExtension({ id: 'example', entityPanels: [{ ...page, entity: 'ext:other:note' }] })).toThrow(
    'namespace',
  );
  const extension = defineWebExtension({ id: 'example', pages: [page] });
  registerWebExtensions([extension]);
  expect(WEB_EXTENSIONS).toEqual([extension]);
  expect(() => registerWebExtensions([extension, extension])).toThrow('Duplicate');
  registerWebExtensions([]);
});
