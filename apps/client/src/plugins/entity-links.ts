/**
 * Plugin record links. React-free (./entity-links.test.ts). A plugin names its record kinds in the
 * station manifest (`entity_kinds`: `ext:crm:company` at `#/crm/companies/:id`); a link that
 * matches one of those route templates opens that record's detail page as a plugin sheet. The
 * template matches segment for segment, so a list address (`#/crm/companies`) is no record.
 */
import type { ManifestState } from './manifest';

export interface PluginEntityLink {
  plugin: string;
  page: string;
  entity: string;
  id: string;
}

function decoded(raw: string): string | null {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

/** The record `hash` names by its route template: `:id` in the path or as a query value. */
function matchRoute(template: string, hash: string): string | null {
  if (!template.startsWith('#/') || !hash.startsWith('#/')) return null;
  const [path, query = ''] = template.slice(2).split('?', 2) as [string, string?];
  const [hashPath, hashQuery = ''] = hash.slice(2).split('?', 2) as [string, string?];
  const want = path.split('/').filter(Boolean);
  const have = hashPath.split('/').filter(Boolean);
  if (want.length !== have.length) return null;
  let id: string | null = null;
  for (let i = 0; i < want.length; i++) {
    if (want[i] === ':id') id = decoded(have[i]!);
    else if (want[i] !== have[i]) return null;
  }
  if (query) {
    const params = new URLSearchParams(hashQuery);
    for (const [key, value] of new URLSearchParams(query)) {
      if (value === ':id') id = params.get(key);
      else if (params.get(key) !== value) return null;
    }
  }
  return id && id.length <= 128 ? id : null;
}

/** The plugin record a `#/…` link names, from the station manifest; null when no plugin names it. */
export function pluginEntityLink(state: ManifestState, hash: string): PluginEntityLink | null {
  if (state.kind !== 'v2') return null;
  for (const plugin of state.manifest.plugins) {
    for (const kind of plugin.entity_kinds ?? []) {
      const id = matchRoute(kind.route, hash);
      if (!id) continue;
      const entity = plugin.entities.find((item) => item.kind === kind.kind);
      if (!entity) continue;
      const page =
        plugin.pages.find((item) => item.kind === 'entity-detail' && item.entity === entity.id) ??
        plugin.pages.find((item) => item.kind === 'entity-list' && item.entity === entity.id);
      if (page) return { plugin: plugin.id, page: page.id, entity: entity.id, id };
    }
  }
  return null;
}
