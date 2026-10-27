/**
 * The Admin place's sections (React-free, tested): core sections are fixed; plugin sections come
 * from the station manifest only — pages a plugin declares with `parent: 'administration'` (a
 * settings form, or a native screen this client compiles). The station serves those pages to
 * supers alone; the place itself is super only too. Core never names a plugin here.
 */
import type { IconName } from '../ui/core';
import type { ManifestState } from '../plugins/manifest';
import type { LocalizedText } from '../shared/plugins';

export const SECTION_GROUPS = ['members', 'spend', 'workspace', 'integrations'] as const;
export type SectionGroup = (typeof SECTION_GROUPS)[number];

export const CORE_SECTIONS = [
  { id: 'users', icon: 'users', group: 'members' },
  { id: 'activity', icon: 'runs', group: 'members' },
  { id: 'usage', icon: 'bar', group: 'spend' },
  { id: 'services', icon: 'pricing', group: 'spend' },
  { id: 'team-context', icon: 'building', group: 'workspace' },
  { id: 'branding', icon: 'palette', group: 'workspace' },
  { id: 'runtime-config', icon: 'sliders', group: 'workspace' },
  { id: 'mcp-keys', icon: 'key', group: 'integrations' },
  { id: 'connectors', icon: 'plug', group: 'integrations' },
  { id: 'plugins', icon: 'apps', group: 'integrations' },
] as const satisfies readonly { id: string; icon: IconName; group: SectionGroup }[];

export type CoreSectionId = (typeof CORE_SECTIONS)[number]['id'];
export const DEFAULT_SECTION: CoreSectionId = 'users';

export function isCoreSection(id: string | undefined): id is CoreSectionId {
  return CORE_SECTIONS.some((section) => section.id === id);
}

export interface PluginSection {
  plugin: string;
  page: string;
  title: LocalizedText;
  icon: IconName;
  href: string;
  /** The classic `#/administration/<key>` this section replaces, when the plugin names one. */
  legacyKey: string | null;
}

/** `#/administration/issues/requests` → `issues`. */
export function legacyKeyOf(fallback: string | undefined): string | null {
  const match = /^#\/administration\/([^/?#]+)/.exec(fallback ?? '');
  return match ? match[1]! : null;
}

export function pluginSectionHref(plugin: string, page: string): string {
  return `/admin/p/${encodeURIComponent(plugin)}/${encodeURIComponent(page)}`;
}

/**
 * Plugin sections in manifest order. A native page needs a screen this client compiles
 * (`icons` holds the known admin screens); anything else would only be a dead row.
 */
export function pluginSections(state: ManifestState, icons: Readonly<Record<string, IconName>>): PluginSection[] {
  if (state.kind !== 'v2') return [];
  return state.manifest.plugins.flatMap((plugin) =>
    plugin.pages.flatMap((page): PluginSection[] => {
      if (!('parent' in page) || page.parent !== 'administration') return [];
      const icon = page.kind === 'native' ? icons[page.screen] : page.kind === 'settings-form' ? 'gear' : undefined;
      if (!icon) return [];
      return [
        {
          plugin: plugin.id,
          page: page.id,
          title: page.title,
          icon,
          href: pluginSectionHref(plugin.id, page.id),
          legacyKey: legacyKeyOf(page.fallback_url),
        },
      ];
    }),
  );
}

/** Which section a path shows: `/admin` is the default section. */
export function activeSection(path: string): { core: CoreSectionId } | { plugin: string; page: string } | null {
  const parts = path.split('?')[0]!.split('/').filter(Boolean);
  if (parts[0] !== 'admin') return null;
  if (parts.length === 1) return { core: DEFAULT_SECTION };
  if (parts[1] === 'p' && parts.length === 4) {
    try {
      return { plugin: decodeURIComponent(parts[2]!), page: decodeURIComponent(parts[3]!) };
    } catch {
      return null;
    }
  }
  return parts.length === 2 && isCoreSection(parts[1]) ? { core: parts[1] } : null;
}

/** An unknown `/admin/<key>` (a classic link): the plugin section that took that key over, if any. */
export function sectionForLegacyKey(key: string, sections: readonly PluginSection[]): PluginSection | null {
  return sections.find((section) => section.legacyKey === key) ?? null;
}
