/** @vitest-environment happy-dom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it } from 'vitest';
import { useExtensionsStore } from '../../../../apps/web/src/stores/extensions-store.js';
import { ExtensionPageHost } from '../../../../apps/web/src/extensions/host.js';
import { registeredEntityKind, registeredHostTitle } from '../../../../apps/web/src/lib/extension-registries.js';
import { getContextProvider } from '../../../../apps/web/src/lib/context-registry.js';
import { entityDomainForTool } from '../../../../apps/web/src/lib/entity-sync.js';
import { platformApplicationHref } from '../../../../apps/web/src/platform/catalog.js';
import extension from '../index.js';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  useExtensionsStore.setState({ extensions: [], loaded: false });
});
it('hides project routes, catalog links and peeks while disabled', async () => {
  useExtensionsStore.setState({ extensions: [], loaded: true });
  expect(registeredEntityKind('project')).toBeUndefined();
  expect(registeredHostTitle('projects')).toBeUndefined();
  expect(getContextProvider('project-list')).toBeUndefined();
  expect(entityDomainForTool('project_mutation')).toBeNull();
  const app = {
    id: 'projects',
    navigation: [],
    title: 'Projects',
    version: '1',
    modules: {},
    actions: {},
    capabilities: [],
  };
  expect(platformApplicationHref(app)).toBeNull();
  const container = document.createElement('div');
  root = createRoot(container);
  await act(async () => {
    root?.render(<ExtensionPageHost route="projects" subPath="" params={new URLSearchParams()} />);
  });
  expect(container.textContent).toContain('not enabled');
});
it('owns the old project hash, context providers and legacy entity kind', () => {
  useExtensionsStore.setState({ extensions: [{ id: 'projects', name: 'Projects', description: null }], loaded: true });
  expect(extension.pages?.[0]).toMatchObject({ route: 'projects', applicationId: 'projects' });
  expect(extension.entityKinds?.[0].kind).toBe('project');
  expect(registeredHostTitle('projects')?.titleKey).toBe('ext.projects.projects.title');
  expect(getContextProvider('project-list')).toBeDefined();
  expect(entityDomainForTool('project_mutation')).toBe('project');
  expect(extension.resolveContext?.('projects', '42', new URLSearchParams())).toEqual({
    type: 'project-detail',
    projectId: '42',
  });
});
