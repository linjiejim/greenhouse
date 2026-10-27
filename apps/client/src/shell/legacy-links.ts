import { objectId } from '../lib/object-id';
/** Classic routes emitted by notifications, entity links, email and IM. No React imports. */
import { parseHashRoute } from '../lib/deep-links';
import { openingOf, refOfTarget } from './object-ref';
const route = (path: string, params: Record<string, string> = {}) =>
  path + (Object.keys(params).length ? `?${new URLSearchParams(params)}` : '');
export function mapLegacyLink(input: string): string | null {
  const hash = input.startsWith('/#/') ? input.slice(1) : input;
  if (!hash.startsWith('#/')) return null;
  const raw = hash.slice(2);
  const [path, query = ''] = raw.split('?', 2);
  const params = new URLSearchParams(query);
  const parts = path!.split('/').filter(Boolean);
  try {
    if (parts[0] === 'chat' && parts.length === 2) return route('/chat', { session: decodeURIComponent(parts[1]!) });
    if (parts[0] === 'kb')
      return mapLegacyLink(
        '#/knowledge' + (parts.length > 1 ? '/' + parts.slice(1).join('/') : '') + (query ? '?' + query : ''),
      );
    if (parts.length === 0 || path === 'home') return '/';
    if (path === 'knowledge') return '/knowledge';
    if (parts[0] === 'knowledge' && parts[1] === 'folder' && parts.length === 3) {
      const id = objectId(parts[2]);
      if (id) return route('/knowledge', { shelf: 'team', folder: id });
    }
    if (parts[0] === 'knowledge' && parts.length === 2 && ['personal', 'shared'].includes(parts[1]!))
      return route('/knowledge', { shelf: parts[1]! });
    if (path === 'notifications')
      return params.get('id') ? route('/sheet/notification', { id: params.get('id')! }) : '/notifications';
    if (path === 'tasks' || path === 'automations') return '/automations';
    if (path === 'settings' || path === 'settings/preferences' || path === 'me') return '/me';
    if (path === 'settings/notifications') return '/me/notifications';
    if (path === 'settings/connectors') return '/me/connectors';
    // Administration lives in the client: an unknown key is resolved against plugin sections there.
    if (parts[0] === 'administration') {
      const key = parts[1] === 'profiles' ? 'usage' : parts[1];
      if (!key) return '/admin';
      return route(`/admin/${encodeURIComponent(decodeURIComponent(key))}`, parts.length > 2 ? { view: parts.slice(2).join('/') } : {});
    }
    if (path === 'login' && !query) return '/login';
    if (parts[0] === 'activity' && parts.length >= 2 && parts.length <= 3)
      return route('/sheet/run', { id: decodeURIComponent(parts.at(-1)!) });
    const target = parseHashRoute(hash);
    if (target) {
      const next = refOfTarget(target);
      if ('ref' in next) {
        const opening = openingOf(next.ref);
        return route(opening.pathname, opening.params);
      }
      const p = next.place;
      switch (p.kind) {
        case 'tab':
          return p.href;
        case 'drive':
          return p.folderId
            ? route('/sheet/folder', { id: p.folderId, shelf: p.shelf, scope: 'drive' })
            : route('/drive', { shelf: p.shelf });
        case 'tables':
          return p.tableId
            ? route('/drive/table', { id: p.tableId })
            : p.baseId
              ? route('/drive/base', { id: p.baseId })
              : '/drive?view=tables';
        case 'agents':
          return '/me/agents';
      }
    }
  } catch {
    /* malformed percent escapes stay on the classic client */
  }
  return '/classic/' + hash;
}
