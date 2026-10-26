/** @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import '../../../../apps/web/src/extensions/index.js';
import { useExtensionsStore } from '../../../../apps/web/src/stores/extensions-store.js';
import { ExtensionPageHost } from '../../../../apps/web/src/extensions/host.js';
import {
  registeredToolCard,
  registeredApplicationRoute,
  registeredEntityKind,
} from '../../../../apps/web/src/lib/extension-registries.js';
import { getContextProvider } from '../../../../apps/web/src/lib/context-registry.js';
afterEach(() => useExtensionsStore.setState({ extensions: [], loaded: false }));
it('removes Tables page, card, entity and context surfaces when disabled', async () => {
  useExtensionsStore.setState({ extensions: [], loaded: true });
  const container = document.createElement('div');
  const root = createRoot(container);
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  await act(async () => root.render(<ExtensionPageHost route="tables" subPath="" params={new URLSearchParams()} />));
  expect(container.textContent).toContain('not enabled');
  await act(async () => root.unmount());
  expect(registeredApplicationRoute('tables')).toBeNull();
  expect(registeredToolCard('tables_schema_plan')).toBeUndefined();
  expect(registeredEntityKind('tables_record')).toBeUndefined();
  expect(getContextProvider('tables')).toBeUndefined();
});
it('keeps the canonical route, confirm card placement and context when active', () => {
  useExtensionsStore.setState({ extensions: [{ id: 'tables', name: 'Tables', description: null }], loaded: true });
  expect(registeredApplicationRoute('tables')).toBe('#/tables');
  expect(registeredToolCard('tables_schema_plan')).toMatchObject({ placement: 'below' });
  expect(getContextProvider('tables')).toBeDefined();
});
