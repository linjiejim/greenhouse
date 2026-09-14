/**
 * Compiled-in web extensions — add yours here (one import, one list entry),
 * next to its API half in apps/api/src/extensions/index.ts.
 *
 * Translations, tool cards and icons are registered for every compiled
 * extension at load (harmless while inactive); pages, navigation and modules
 * are only rendered for the ids the API reports as active.
 */
import { registerExtensionMessages } from '../lib/i18n';
import { registerExtensionNavModules, registerExtensionPageModules } from '../lib/nav-registry';
import { registerExtensionContextProvider } from '../lib/context-registry';
import { useExtensionsStore } from '../stores/extensions-store';
import {
  registerEntityKindUi,
  registerKnowledgeDocPanels,
  registerMcpGroupUi,
  registerToolCard,
  registerToolIcons,
} from '../lib/extension-registries';
import type { WebExtension, WebExtensionModule, WebExtensionNavItem, WebExtensionPage } from './define';
import { exampleWebExtension } from './example';

export const COMPILED_WEB_EXTENSIONS: readonly WebExtension[] = [exampleWebExtension];

const byId = new Map<string, WebExtension>();
for (const ext of COMPILED_WEB_EXTENSIONS) {
  if (byId.has(ext.id))
    throw new Error(`Web extension id "${ext.id}" is listed twice in apps/web/src/extensions/index.ts`);
  byId.set(ext.id, ext);
}

// ─── Load-time registrations (compiled set) ─────────────

for (const ext of COMPILED_WEB_EXTENSIONS) {
  if (ext.messages) registerExtensionMessages(ext.id, ext.messages);
  if (ext.modules?.length) registerExtensionNavModules(ext.id, ext.modules);
  for (const page of ext.pages ?? []) {
    if (page.modules?.length) registerExtensionPageModules(ext.id, page.route, page.modules, page.titleKey);
  }
  if (ext.contextProvider) registerExtensionContextProvider(ext.id, ext.contextProvider);
  for (const card of ext.toolCards ?? []) {
    registerToolCard(card.tool, { component: card.component, placement: card.placement ?? 'inline' });
  }
  if (ext.toolIcons) registerToolIcons(ext.toolIcons);
  if (ext.entityKinds?.length) registerEntityKindUi(ext.entityKinds);
  if (ext.mcpGroups?.length) {
    registerMcpGroupUi(ext.mcpGroups.map((group) => ({ ...group, extensionId: ext.id })));
  }
  if (ext.knowledgeDocPanels?.length) {
    registerKnowledgeDocPanels(ext.knowledgeDocPanels.map((panel) => ({ ...panel, extensionId: ext.id })));
  }
  ext.onLoad?.();
}

// ─── Lookups ────────────────────────────────────────────

/** Ids the connected API reports as active (empty until the extensions store loads). */
function activeIds(): Set<string> {
  return new Set(useExtensionsStore.getState().extensions.map((e) => e.id));
}

export function isActiveWebExtension(id: string): boolean {
  return activeIds().has(id);
}

/** Every compiled page route — used by the hash router, which must parse before the store loads. */
export function compiledExtensionRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const ext of COMPILED_WEB_EXTENSIONS) for (const page of ext.pages ?? []) routes.add(page.route);
  return routes;
}

export function findExtensionPage(route: string): { extension: WebExtension; page: WebExtensionPage } | null {
  for (const ext of COMPILED_WEB_EXTENSIONS) {
    const page = ext.pages?.find((p) => p.route === route);
    if (page) return { extension: ext, page };
  }
  return null;
}

/** Navigation items of the active extensions, in registration order. */
export function activeExtensionNavItems(active: ReadonlySet<string> = activeIds()): WebExtensionNavItem[] {
  return COMPILED_WEB_EXTENSIONS.filter((ext) => active.has(ext.id)).flatMap((ext) => ext.navigation ?? []);
}

export function extensionModuleComponent(
  parent: 'settings' | 'administration',
  key: string,
): WebExtensionModule | undefined {
  for (const ext of COMPILED_WEB_EXTENSIONS) {
    const mod = ext.modules?.find((m) => m.parent === parent && m.key === key);
    if (mod) return mod;
  }
  return undefined;
}
