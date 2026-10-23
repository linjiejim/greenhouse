/**
 * The home-screen widgets' data. React-free (./model.test.ts). The app writes one JSON snapshot
 * into the App Group (modules/widget-bridge), and targets/widget/index.swift decodes exactly this
 * shape (keep `WidgetSnapshot` there in step): "我的任务" shows the next three tasks due, "最近文档"
 * the three documents opened last. A snapshot belongs to one station and member and carries only
 * what the widgets show — titles, dates and ids, never a token. Tapping an item opens a
 * `greenhouse://` link that names the station; the app opens it only on that station
 * (`widgetLinkPath`).
 */

import { docMiss, type RecentDoc } from '../data/recent-docs';
import type { DueBucket, MyTask } from '../data/tasks';

export const WIDGET_TASKS = 3;
export const WIDGET_DOCS = 3;

export interface WidgetTask {
  title: string;
  project: string;
  /** `YYYY-MM-DD`, or null. */
  due: string | null;
  bucket: DueBucket;
  url: string;
}

export interface WidgetDoc {
  title: string;
  /** Unix seconds. */
  openedAt: number;
  url: string;
}

export interface WidgetSnapshot {
  v: 1;
  stationName: string;
  lang: 'zh' | 'en';
  /** Unix seconds. */
  updatedAt: number;
  tasks: WidgetTask[];
  docs: WidgetDoc[];
}

const link = (path: string, params: Record<string, string>, station: string) =>
  `greenhouse://${path}?${new URLSearchParams({ ...params, station }).toString()}`;

/** The snapshot for one station + member, from the app's offline copies. */
export function buildSnapshot(input: {
  station: { id: string; name: string };
  lang: 'zh' | 'en';
  myTasks: readonly { bucket: DueBucket; tasks: readonly MyTask[] }[] | null;
  recentDocs: readonly RecentDoc[];
  now: number;
}): WidgetSnapshot {
  const tasks = (input.myTasks ?? [])
    .flatMap((group) => group.tasks.map((task) => ({ task, bucket: group.bucket })))
    .slice(0, WIDGET_TASKS)
    .map(
      ({ task, bucket }): WidgetTask => ({
        title: task.title,
        project: task.project_title,
        due: task.due_date ? task.due_date.slice(0, 10) : null,
        bucket,
        url: link('projects/task', { project: String(task.project_id), task: String(task.id) }, input.station.id),
      }),
    );
  const docs = input.recentDocs.slice(0, WIDGET_DOCS).map(
    (doc): WidgetDoc => ({
      title: doc.title,
      openedAt: Math.floor(doc.openedAt / 1000),
      url: link('knowledge/doc', { id: String(doc.id) }, input.station.id),
    }),
  );
  return {
    v: 1,
    stationName: input.station.name,
    lang: input.lang,
    updatedAt: Math.floor(input.now / 1000),
    tasks,
    docs,
  };
}

/**
 * What the foreground refresh of my tasks does with the saved copy the widget reads: save the
 * station's answer, delete the copy when the station says it is gone or no longer mine (403 / 404
 * / 410; the widget is then republished without tasks), or keep it on any other miss.
 */
export function myTasksRefreshAction(result: { ok: true } | { ok: false; status: number }): 'save' | 'delete' | 'keep' {
  if (result.ok) return 'save';
  return docMiss(result.status) === 'gone' ? 'delete' : 'keep';
}

/**
 * Where a link from a widget goes in the app: its own path when it names the active station
 * (the `station` parameter removed), home when it names another one or the path is not a widget
 * item. On a cold start the active station is not read yet (null): the item opens, and it loads
 * from whichever station becomes active — the snapshot is rewritten on every switch, and a stale
 * item answers "not available". Other links pass through unchanged.
 */
export function widgetLinkPath(path: string, activeStation: string | null): string {
  let url: URL;
  try {
    url = new URL(path, 'greenhouse://app');
  } catch {
    return path;
  }
  const station = url.searchParams.get('station');
  if (station === null) return path;
  const route = `${url.host === 'app' ? '' : `/${url.host}`}${url.pathname}`.replace(/\/+/g, '/');
  if (route !== '/projects/task' && route !== '/knowledge/doc') return '/';
  if (activeStation !== null && station !== activeStation) return '/';
  url.searchParams.delete('station');
  const query = url.searchParams.toString();
  return `${route}${query ? `?${query}` : ''}`;
}
