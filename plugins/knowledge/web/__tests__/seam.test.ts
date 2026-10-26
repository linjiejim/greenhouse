/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest';
import { isActiveWebExtension, extensionSlots, extensionSurfaces } from '../../../../apps/web/src/extensions/index.js';
import { useExtensionsStore } from '../../../../apps/web/src/stores/extensions-store.js';
import {
  registeredApplicationRoute,
  registeredEntityKind,
  registeredToolIcon,
  registeredDefaultQuickActions,
} from '../../../../apps/web/src/lib/extension-registries.js';
import { entityDomainForTool } from '../../../../apps/web/src/lib/entity-sync.js';
afterEach(() => useExtensionsStore.setState({ extensions: [], loaded: false }));
it('hides the library, peek, picker, tools and search launcher when disabled', () => {
  useExtensionsStore.setState({ extensions: [], loaded: true });
  expect(isActiveWebExtension('knowledge')).toBe(false);
  expect(registeredApplicationRoute('knowledge')).toBeNull();
  expect(registeredEntityKind('kb_doc')).toBeUndefined();
  expect(registeredToolIcon('knowledge_query')).toBeUndefined();
  expect(entityDomainForTool('knowledge_mutation')).toBeNull();
  expect(extensionSlots('team-context.documents')).toEqual([]);
  expect(registeredDefaultQuickActions()).toEqual([]);
  expect(extensionSurfaces()).toEqual([]);
});
it('preserves the legacy route, kind and picker when enabled', () => {
  useExtensionsStore.setState({
    extensions: [{ id: 'knowledge', name: 'Knowledge', description: null }],
    loaded: true,
  });
  expect(registeredApplicationRoute('knowledge')).toBe('#/knowledge');
  expect(registeredEntityKind('kb_doc')).toBeDefined();
  expect(registeredToolIcon('knowledge_query')).toBeDefined();
  expect(entityDomainForTool('knowledge_mutation')).toBe('knowledge');
  expect(extensionSlots('team-context.documents')).toHaveLength(1);
  expect(registeredDefaultQuickActions()).toHaveLength(1);
});
