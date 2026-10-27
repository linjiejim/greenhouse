import { expect, it } from 'vitest';
import { boundedInspectorWidth, inspectorCount, promotedInspectorRoutes } from './inspector-model';
import { sheetDepth, sheetMove } from './object-ref';
it('bounds inspectors at three and includes tool steps', () => {
  const routes = [{ name: '(drawer)' }, { name: 'sheet/doc' }, { name: 'sheet/task' }, { name: 'sheet/steps' }];
  expect(inspectorCount(routes)).toBe(3);
  expect(sheetMove(sheetDepth(routes))).toBe('replace');
});
it('starts a new inspector stack above an object promoted to main', () => {
  expect(inspectorCount([{ name: 'sheet/doc', params: { main: '1' } }, { name: 'sheet/file' }])).toBe(1);
});
it('keeps inspector resizing within the design limits', () => {
  expect([0, 400, 1000].map(boundedInspectorWidth)).toEqual([360, 400, 520]);
});

it('promotes in place, retaining the selected route key and removing older inspectors', () => {
  const doc = { name: 'sheet/doc', key: 'doc', params: { id: '7' } };
  expect(
    promotedInspectorRoutes([{ name: '(drawer)', key: 'home' }, { name: 'sheet/file', key: 'file' }, doc]),
  ).toEqual([
    { name: '(drawer)', key: 'home' },
    { ...doc, params: { id: '7', main: '1' } },
  ]);
});
it('replaces a previously promoted main object when promoting another inspector', () => {
  expect(
    promotedInspectorRoutes([
      { name: '(drawer)' },
      { name: 'sheet/doc', params: { main: '1' } },
      { name: 'sheet/task', params: { id: '9' } },
    ]),
  ).toEqual([{ name: '(drawer)' }, { name: 'sheet/task', params: { id: '9', main: '1' } }]);
});
