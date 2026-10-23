/**
 * Which usage module a route is — the web half of `page_open` counting.
 *
 * Top-level pages count under their route name, Settings / Administration under
 * the navigation module id the page renders, and every surface an extension
 * contributes under `ext.<extension id>`. The API accepts only these ids
 * (`isPageModuleId` in @greenhouse/types/usage); page-module.test.ts pins this
 * mapping to the navigation registry so the two lists cannot drift.
 */

import { extensionPageModuleId } from '@greenhouse/types/usage';
import { administrationModules, settingsAllModules, type NavModule } from '../nav-registry';

/** Top-level routes that count as themselves. `design` is a developer page and is not a module. */
export const COUNTED_TOP_LEVEL_ROUTES = [
  'chat',
  'knowledge',
  'projects',
  'tables',
  'files',
  'automations',
  'tasks',
  'agents',
  'skillhub',
  'activity',
] as const;

const TOP_LEVEL = new Set<string>(COUNTED_TOP_LEVEL_ROUTES);

/** Mirrors the pages' own fallbacks: an unknown key renders the default module. */
const DEFAULT_MODULE_KEY: Record<'settings' | 'administration', string> = {
  settings: 'preferences',
  administration: 'users',
};

function moduleKey(module: NavModule): string {
  return module.id.split('.').pop() ?? module.id;
}

function navModuleUsageId(module: NavModule): string {
  return module.extensionId ? extensionPageModuleId(module.extensionId) : module.id;
}

function overlayModuleId(route: 'settings' | 'administration', subPath: string): string | null {
  const modules = route === 'settings' ? settingsAllModules : administrationModules;
  let key = subPath.split('/').filter(Boolean)[0] ?? DEFAULT_MODULE_KEY[route];
  // `#/administration/profiles` is the historical name of the usage page.
  if (route === 'administration' && key === 'profiles') key = 'usage';
  const match =
    modules.find((m) => moduleKey(m) === key) ?? modules.find((m) => moduleKey(m) === DEFAULT_MODULE_KEY[route]);
  return match ? navModuleUsageId(match) : null;
}

/**
 * The usage module of a parsed route, or null for a route that is not counted.
 * `extensionId` is the extension that owns `#/<extensionRoute>`.
 */
export function pageModuleForRoute(args: {
  route: string;
  subPath: string;
  extensionId?: string | null;
}): string | null {
  if (args.route === 'extension') return args.extensionId ? extensionPageModuleId(args.extensionId) : null;
  if (args.route === 'settings' || args.route === 'administration') return overlayModuleId(args.route, args.subPath);
  return TOP_LEVEL.has(args.route) ? args.route : null;
}
