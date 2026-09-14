/**
 * The web half of the extension seam, at the registry level: routes, copy,
 * navigation, settings modules, tool cards / icons and agent context all see
 * the example extension, and the "active" gate hides what the API did not
 * switch on.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  COMPILED_WEB_EXTENSIONS,
  activeExtensionNavItems,
  compiledExtensionRoutes,
  extensionModuleComponent,
  findExtensionPage,
} from '../index';
import { translate } from '../../lib/i18n';
import { isEntityUrl, parseEntityUrl } from '@greenhouse/types/entity-links';
import { availableRecipes } from '@greenhouse/types/workbench';
import {
  getNavModule,
  isNavModuleActive,
  localizeNavModule,
  resolveSubModule,
  settingsSections,
} from '../../lib/nav-registry';
import { registeredEntityKind, registeredKnowledgeDocPanels, registeredToolCard } from '../../lib/extension-registries';
import { entityPeekMeta } from '../../components/entity-peek/registry';
import { mcpGroupIds, mcpGroupLabelKey } from '../../lib/mcp-groups';
import { recipeLabels } from '../../lib/workbench/recipes';
import { WIDGET_RECIPES } from '@greenhouse/types/workbench';
import { getToolIcon, StickyNote } from '../../lib/icons';
import { isArtifactCall } from '../../components/tool-call/body-artifacts';
import { getContextProvider } from '../../lib/context-registry';
import { resolveUrlContext } from '../../components/agent-context';
import { useExtensionsStore } from '../../stores/extensions-store';

describe('web extension seam', () => {
  it('compiles the example and exposes its page route', () => {
    // `toContain`, not equality: a fork compiles its own extensions in beside this one.
    expect(COMPILED_WEB_EXTENSIONS.map((e) => e.id)).toContain('example');
    expect(compiledExtensionRoutes().has('example')).toBe(true);
    expect(findExtensionPage('example')?.extension.id).toBe('example');
    expect(findExtensionPage('nope')).toBeNull();
  });

  it('merges extension copy under ext.<id> with an English fallback', () => {
    expect(translate('en', 'ext.example.title')).toBe('Example notes');
    expect(translate('zh', 'ext.example.title')).toBe('示例笔记');
    expect(translate('zh', 'ext.example.card.count', { count: 2 })).toBe('2 条笔记');
    expect(translate('en', 'ext.example.missing')).toBe('ext.example.missing');
  });

  it('shows navigation and modules only while the extension is active', () => {
    expect(activeExtensionNavItems(new Set())).toEqual([]);
    expect(activeExtensionNavItems(new Set(['example'])).map((i) => i.href)).toEqual(['#/example']);

    const mod = getNavModule('settings.example');
    expect(mod?.extensionId).toBe('example');
    expect(mod?.path).toBe('#/settings/example');
    expect(settingsSections.find((s) => s.key === 'extensions')?.items).toContain(mod);
    expect(isNavModuleActive(mod!, [])).toBe(false);
    expect(isNavModuleActive(mod!, [{ id: 'example' }])).toBe(true);
    expect(localizeNavModule(mod!, (key) => translate('zh', key)).label).toBe('示例笔记');
    expect(extensionModuleComponent('settings', 'example')?.key).toBe('example');
    expect(extensionModuleComponent('administration', 'example')).toBeUndefined();
  });

  it('registers the tool card and icon', () => {
    expect(registeredToolCard('example_notes_query')?.placement).toBe('inline');
    expect(getToolIcon('example_notes_query')).toBe(StickyNote);
    expect(isArtifactCall({ name: 'example_notes_query', output: { count: 0, notes: [] } })).toBe(true);
    expect(isArtifactCall({ name: 'example_notes_query' })).toBe(false);
    expect(isArtifactCall({ name: 'example_notes_query', output: { error: 'boom' } })).toBe(false);
  });

  it('routes agent context for extension pages to the extension provider', () => {
    const ctx = resolveUrlContext('#/example/anything?x=1');
    expect(ctx).toEqual({ type: 'extension', extension: 'example', route: 'example', subPath: 'anything' });
    const provider = getContextProvider('extension', ctx);
    expect(provider?.label(ctx as never)).toBe('Example notes');
    expect(
      getContextProvider('extension', { type: 'extension', extension: 'ghost', route: 'ghost', subPath: '' }),
    ).toBeUndefined();
  });

  it('registers the record kind, its peek chrome and the MCP group copy', () => {
    expect(registeredEntityKind('ext:example:note')?.icon).toBe(StickyNote);
    const meta = entityPeekMeta('ext:example:note');
    expect(meta.icon).toBe(StickyNote);
    expect(translate('zh', meta.fallbackTitleKey as never)).toBe('笔记');
    // an unknown kind still renders a peek frame rather than crashing the host
    expect(entityPeekMeta('ext:ghost:thing').icon).toBeTruthy();

    expect(mcpGroupLabelKey('example')).toBe('ext.example.mcpGroup.label');
    expect(mcpGroupLabelKey('knowledge')).toBe('mcpGroups.knowledge.label');
    expect(mcpGroupIds([])).not.toContain('example');
    expect(mcpGroupIds(['example'])).toContain('example');

    expect(registeredKnowledgeDocPanels().map((p) => p.id)).toEqual(['example-doc-note']);
  });

  it('labels an extension recipe from its own keys', () => {
    const recipe = {
      id: 'example.notes',
      toolId: 'example_notes_query',
      label: 'Example notes',
      description: 'desc',
      labelKey: 'ext.example.recipe.notes',
      descriptionKey: 'ext.example.recipe.notesDesc',
      display: 'table' as const,
      source: { toolId: 'example_notes_query', input: {} },
      size: { w: 6, h: 5 },
    };
    expect(translate('zh', recipeLabels(recipe).labelKey as never)).toBe('示例笔记');
    // core recipes keep their closed table
    expect(recipeLabels(WIDGET_RECIPES[0]).labelKey).toBe('home.recipe.projectsList');
  });

  it('keeps the store fail-closed until the API answers', () => {
    expect(useExtensionsStore.getState().loaded).toBe(false);
    expect(useExtensionsStore.getState().extensions).toEqual([]);
  });

  it('gives an extension page its own sub-module identities and breadcrumb', () => {
    // `<ModulePage moduleId="example.notes">` resolves against this.
    const mod = getNavModule('example.notes');
    expect(mod).toBeDefined();
    expect(mod?.parent).toBe('standalone');
    expect(mod?.path).toBe('#/example/notes');
    expect(mod?.extensionId).toBe('example');
    expect(localizeNavModule(mod!, (key) => translate('en', key)).label).toBe('Example notes');

    // The breadcrumb root comes from the page's own title key, not a core table.
    expect(resolveSubModule('example', 'notes', (key) => translate('en', key))).toMatchObject({
      primary: 'Example notes',
      secondary: 'Example notes',
    });
    // A detail path still resolves to its parent module.
    expect(resolveSubModule('example', 'notes/42', (key) => translate('en', key))).toMatchObject({
      secondary: 'Example notes › #42',
    });
    // Still hidden while the extension is inactive.
    expect(isNavModuleActive(mod!, [])).toBe(false);
    expect(isNavModuleActive(mod!, [{ id: 'example' }])).toBe(true);
  });

  it('learns record routes and recipes from the API, so links and cards resolve in the browser', async () => {
    // Before the store loads, an extension deeplink is just a link.
    expect(isEntityUrl('#/example/notes/7')).toBe(false);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          extensions: [{ id: 'example', name: 'Example notes', description: null }],
          entityKinds: [{ kind: 'ext:example:note', route: '#/example/notes/:id' }],
          workbenchRecipes: [
            {
              id: 'example.notes',
              toolId: 'example_notes_query',
              label: 'Example notes',
              description: 'desc',
              display: 'table',
              source: { toolId: 'example_notes_query', input: {} },
              size: { w: 6, h: 5 },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    try {
      await useExtensionsStore.getState().load();
      expect(useExtensionsStore.getState().extensions.map((e) => e.id)).toEqual(['example']);
      // Now the same link opens a peek, and the card picker offers the recipe.
      expect(isEntityUrl('#/example/notes/7')).toBe(true);
      expect(parseEntityUrl('#/example/notes/7')).toEqual({ kind: 'ext:example:note', id: 7 });
      expect(availableRecipes(['example_notes_query']).map((r) => r.id)).toEqual(['example.notes']);

      // A second load (re-login) must not throw on the already-known entries.
      await expect(useExtensionsStore.getState().load()).resolves.toBeUndefined();
    } finally {
      fetchSpy.mockRestore();
      useExtensionsStore.getState().reset();
    }
  });
});
