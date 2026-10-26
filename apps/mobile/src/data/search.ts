/**
 * The search tab's results. React-free (./search.test.ts). One query goes to three places: the
 * station's search (`/api/search`: conversations, automations, projects, documents), 云盘 names
 * (`/api/drive/search`) and my tasks kept on the phone (matched by title here, so they are found
 * offline too). Every hit becomes an object to open; groups keep the station's order.
 */

import type { ObjectRef } from '../shell/object-ref';
import type { SearchGroup } from '../shared/greenhouse-types';
import type { MyTask } from './tasks';
import { objectId } from '../lib/object-id';

export type SearchSectionKind = 'session' | 'automation' | 'kb_doc' | 'project' | 'file' | 'task' | 'other';

/** A station hit, plus the fields newer stations send (automation hits; a conversation's last activity). */
type StationHit = SearchGroup['items'][number] & { automationId?: string; updatedAt?: string };

export interface SearchHitView {
  key: string;
  title: string;
  subtitle?: string;
  ref: ObjectRef;
  fileName?: string;
}

export interface SearchSection {
  kind: SearchSectionKind;
  hits: SearchHitView[];
}

/** A hit's id (src/lib/object-id.ts); older stations send numbers. */
const positive = objectId;

/**
 * `formatTime` turns a conversation's ISO `updatedAt` into the subtitle (the screen passes its
 * locale-aware formatter); without it, or from an older station, the station's subtitle is used.
 */
export function stationSections(groups: readonly SearchGroup[], formatTime?: (iso: string) => string): SearchSection[] {
  const out: SearchSection[] = [];
  for (const group of groups) {
    const hits = group.items.flatMap((raw): SearchHitView[] => {
      const item: StationHit = raw;
      if (item.sessionId) {
        const subtitle = item.updatedAt && formatTime ? formatTime(item.updatedAt) : (item.subtitle ?? undefined);
        return [{ key: `s-${item.sessionId}`, title: item.title, subtitle, ref: { kind: 'chat', sessionId: item.sessionId } }];
      }
      const automationId = positive(item.automationId);
      if (automationId) return [{ key: `a-${automationId}`, title: item.title, subtitle: item.subtitle ?? undefined, ref: { kind: 'automation', id: automationId } }];
      const id = positive(item.ref?.id);
      if (!id) return [];
      if (item.ref?.kind === 'kb_doc') return [{ key: `d-${id}`, title: item.title, subtitle: item.subtitle ?? undefined, ref: { kind: 'doc', id } }];
      if (item.ref?.kind === 'project') return [{ key: `p-${id}`, title: item.title, subtitle: item.subtitle ?? undefined, ref: { kind: 'project', id } }];
      // kinds extensions add have no sheet on the phone yet
      return [];
    });
    if (!hits.length) continue;
    const kind: SearchSectionKind = group.kind === 'session' || group.kind === 'automation' || group.kind === 'kb_doc' || group.kind === 'project' ? group.kind : 'other';
    out.push({ kind, hits });
  }
  return out;
}

export function fileSection(files: readonly { id: string; name: string; size?: number }[], detail: (size?: number) => string): SearchSection | null {
  if (!files.length) return null;
  return {
    kind: 'file',
    hits: files.map((file) => ({ key: `f-${file.id}`, title: file.name, subtitle: detail(file.size), fileName: file.name, ref: { kind: 'file', id: file.id, name: file.name } })),
  };
}

export function taskSection(tasks: readonly MyTask[], query: string): SearchSection | null {
  const q = query.trim().toLowerCase();
  if (!q) return null;
  const hits = tasks
    .filter((task) => task.title.toLowerCase().includes(q))
    .slice(0, 10)
    .map((task): SearchHitView => ({ key: `t-${task.id}`, title: task.title, subtitle: task.project_title, ref: { kind: 'task', projectId: task.project_id, id: task.id } }));
  return hits.length ? { kind: 'task', hits } : null;
}
