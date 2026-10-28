import { objectId } from '../lib/object-id';
/** Preserve the phone's existing routes (widgets use greenhouse://sheet/doc?... too). */
export function desktopLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'greenhouse:' || url.username || url.password || url.port || url.hash) return null;
    const path = '/' + [url.host, ...url.pathname.split('/').filter(Boolean)].filter(Boolean).join('/');
    const q = url.searchParams;
    const station = q.get('station') ? `&station=${encodeURIComponent(q.get('station')!)}` : '';
    if (path === '/knowledge/doc' && objectId(q.get('id'))) {
      const params = new URLSearchParams({ id: q.get('id')! });
      if (q.get('station')) params.set('station', q.get('station')!);
      return `/sheet/doc?${params}`;
    }
    if (path === '/projects/task' && objectId(q.get('task')) && objectId(q.get('project'))) {
      const params = new URLSearchParams({ id: q.get('task')!, project: q.get('project')! });
      if (q.get('station')) params.set('station', q.get('station')!);
      return `/sheet/task?${params}`;
    }
    if (path === '/chat' && /^[A-Za-z0-9_-]{1,128}$/.test(q.get('session') ?? ''))
      return `/chat?session=${encodeURIComponent(q.get('session')!)}`;
    if (path === '/sheet/doc' && objectId(q.get('id')))
      return `/sheet/doc?id=${encodeURIComponent(q.get('id')!)}${station}`;
    if (path === '/sheet/task' && objectId(q.get('id')) && objectId(q.get('project')))
      return `/sheet/task?id=${encodeURIComponent(q.get('id')!)}&project=${encodeURIComponent(q.get('project')!)}${station}`;
    // Friendly aliases, normalized to the same app routes.
    const [kind, id, extra] = path.slice(1).split('/');
    if (!extra && kind === 'conversations' && /^[A-Za-z0-9_-]{1,128}$/.test(id ?? ''))
      return `/chat?session=${encodeURIComponent(id)}`;
    if (!extra && kind === 'documents' && objectId(id)) return `/sheet/doc?id=${encodeURIComponent(id)}${station}`;
    if (!extra && kind === 'tasks' && objectId(id) && objectId(q.get('project')))
      return `/sheet/task?id=${encodeURIComponent(id)}&project=${encodeURIComponent(q.get('project')!)}${station}`;
    return null;
  } catch {
    return null;
  }
}
