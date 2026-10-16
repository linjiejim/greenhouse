import { expect, it } from 'vitest';
import { pointer, mapExternal } from '../external.js';
it('uses RFC 6901 own properties, bounds rows and renders scalar data only', () => {
  expect(pointer({ 'a/b': { '~x': 4 } }, '/a~1b/~0x')).toBe(4);
  expect(pointer({}, '/constructor')).toBeNull();
  expect(() => pointer({}, 'bad')).toThrow();
  expect(
    mapExternal(
      {
        id: 'data',
        title: 'Data',
        kind: 'external',
        source: { connector: 'x', tool: 'read', arguments: {} },
        map: { kind: 'table', rows: '/rows', columns: [{ label: 'Data', path: '/value' }] },
      },
      { rows: Array.from({ length: 110 }, () => ({ value: { html: '<script>' } })) },
    ),
  ).toMatchObject({ kind: 'external', rows: Array.from({ length: 100 }, () => [null]) });
});
