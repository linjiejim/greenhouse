/**
 * The web half of the extension seam, at the registry level: routes, copy,
 * navigation, settings modules, tool cards / icons and agent context all see
 * the example extension, and the "active" gate hides what the API did not
 * switch on.
 */
import { describe, expect, it } from 'vitest';
import {
  COMPILED_WEB_EXTENSIONS,
  activeExtensionNavItems,
  compiledExtensionRoutes,
  extensionModuleComponent,
  findExtensionPage,
} from '../index';
import { translate } from '../../lib/i18n';
import { getNavModule, isNavModuleActive, localizeNavModule, settingsSections } from '../../lib/nav-registry';
import { registeredToolCard } from '../../lib/extension-registries';
import { getToolIcon, StickyNote } from '../../lib/icons';
import { isArtifactCall } from '../../components/tool-call/body-artifacts';
import { getContextProvider } from '../../lib/context-registry';
import { resolveUrlContext } from '../../components/agent-context';
import { useExtensionsStore } from '../../stores/extensions-store';

describe('web extension seam', () => {
  it('compiles the example and exposes its page route', () => {
    expect(COMPILED_WEB_EXTENSIONS.map((e) => e.id)).toEqual(['example']);
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

  it('keeps the store fail-closed until the API answers', () => {
    expect(useExtensionsStore.getState().loaded).toBe(false);
    expect(useExtensionsStore.getState().extensions).toEqual([]);
  });
});
