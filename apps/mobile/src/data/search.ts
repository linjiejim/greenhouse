/**
 * The search tab's results. React-free (./search.test.ts). One query goes to three places: the
 * station's search (`/api/search`: conversations, projects, documents), 云盘 names
 * (`/api/drive/search`) and my tasks kept on the phone (matched by title here, so they are found
 * offline too). Every hit becomes an object to open; groups keep the station's order.
 */

import type { ObjectRef } from '../shell/object-ref';
import type { SearchGroup } from '../shared/greenhouse-types';
import type { MyTask } from './tasks';

export type SearchSectionKind = 'session' | 'kb_doc' | 'project' | 'file' | 'task' | 'other';

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

const positive = (value: unknown): number | null => {
  const n = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
};

export function stationSections(groups: readonly SearchGroup[]): SearchSection[] {
  const out: SearchSection[] = [];
  for (const group of groups) {
    const hits = group.items.flatMap((item): SearchHitView[] => {
      if (item.sessionId) return [{ key: `s-${item.sessionId}`, title: item.title, subtitle: item.subtitle ?? undefined, ref: { kind: 'chat', sessionId: item.sessionId } }];
      const id = positive(item.ref?.id);
      if (!id) return [];
      if (item.ref?.kind === 'kb_doc') return [{ key: `d-${id}`, title: item.title, subtitle: item.subtitle ?? undefined, ref: { kind: 'doc', id } }];
      if (item.ref?.kind === 'project') return [{ key: `p-${id}`, title: item.title, subtitle: item.subtitle ?? undefined, ref: { kind: 'project', id } }];
      // kinds extensions add have no sheet on the phone yet
      return [];
    });
    if (!hits.length) continue;
    const kind: SearchSectionKind = group.kind === 'session' || group.kind === 'kb_doc' || group.kind === 'project' ? group.kind : 'other';
    out.push({ kind, hits });
  }
  return out;
}

export function fileSection(files: readonly { id: number; name: string; size?: number }[], detail: (size?: number) => string): SearchSection | null {
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
