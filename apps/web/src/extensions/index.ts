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

// Legacy hashes (`pages[].aliases`) are resolved by the router before extension
// routes, so across the compiled set each must be unique and none may shadow a
// live route. Checked once at load: a conflict is a build mistake, not a runtime state.
const ROUTE_ALIASES = new Map<string, string>();
{
  const routes = new Set(COMPILED_WEB_EXTENSIONS.flatMap((ext) => (ext.pages ?? []).map((page) => page.route)));
  for (const ext of COMPILED_WEB_EXTENSIONS) {
    for (const page of ext.pages ?? []) {
      for (const [from, to] of Object.entries(page.aliases ?? {})) {
        if (routes.has(from))
          throw new Error(`Web extension "${ext.id}" alias "${from}" shadows a compiled extension route`);
        if (ROUTE_ALIASES.has(from)) throw new Error(`Web extension "${ext.id}" alias "${from}" is claimed twice`);
        ROUTE_ALIASES.set(from, to);
      }
    }
  }
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

/** Legacy top-level hashes (`pages[].aliases`) → the path (relative to `#/`) they redirect to. */
export function compiledExtensionRouteAliases(): ReadonlyMap<string, string> {
  return ROUTE_ALIASES;
}

/** One hash a browser can open because an extension registered it. */
export interface ExtensionSurface {
  extensionId: string;
  kind: 'page' | 'page-module' | 'navigation' | 'settings-module' | 'administration-module' | 'alias';
  hash: string;
  /** For `alias`: the hash the surface must redirect to. */
  redirectsTo?: string;
  requireRole?: 'super'[];
  requireFeature?: string;
  hiddenFromNav?: boolean;
}

/**
 * Every hash the ACTIVE extensions answer for — pages, page modules, "More"
 * entries, Settings / Administration modules and legacy aliases. This is what
 * the generic browser sweep (tests/e2e-ui/extension-surfaces.spec.ts) opens one
 * by one; it is exposed on `window.__greenhouseExtensionSurfaces` so the test
 * reads it from the running page instead of keeping a second list.
 */
export function extensionSurfaces(active: ReadonlySet<string> = activeIds()): ExtensionSurface[] {
  const surfaces: ExtensionSurface[] = [];
  for (const ext of COMPILED_WEB_EXTENSIONS) {
    if (!active.has(ext.id)) continue;
    for (const page of ext.pages ?? []) {
      surfaces.push({ extensionId: ext.id, kind: 'page', hash: `#/${page.route}` });
      for (const mod of page.modules ?? []) {
        surfaces.push({
          extensionId: ext.id,
          kind: 'page-module',
          hash: `#/${page.route}/${mod.key}`,
          requireRole: mod.requireRole,
          requireFeature: mod.requireFeature,
          hiddenFromNav: mod.hiddenFromNav,
        });
      }
      for (const [from, to] of Object.entries(page.aliases ?? {})) {
        surfaces.push({ extensionId: ext.id, kind: 'alias', hash: `#/${from}`, redirectsTo: `#/${to}` });
      }
    }
    for (const item of ext.navigation ?? []) {
      surfaces.push({
        extensionId: ext.id,
        kind: 'navigation',
        hash: item.href,
        requireRole: item.requireRole,
        requireFeature: item.requireFeature,
      });
    }
    for (const mod of ext.modules ?? []) {
      surfaces.push({
        extensionId: ext.id,
        kind: mod.parent === 'settings' ? 'settings-module' : 'administration-module',
        hash: `#/${mod.parent}/${mod.key}`,
        requireRole: mod.requireRole,
        requireFeature: mod.requireFeature,
      });
    }
  }
  return surfaces;
}

declare global {
  interface Window {
    __greenhouseExtensionSurfaces?: (activeIds?: string[]) => ExtensionSurface[];
  }
}
if (typeof window !== 'undefined') {
  window.__greenhouseExtensionSurfaces = (ids) => extensionSurfaces(ids ? new Set(ids) : undefined);
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
