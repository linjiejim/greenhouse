import { describe, expect, it } from 'vitest';
import type { MyTask } from '../data/tasks';
import { buildSnapshot, isWidgetItemPath, myTasksRefreshAction, widgetLinkPath, widgetStationGate } from './model';

const task = (id: number, due: string | null): MyTask =>
  ({
    id,
    project_id: 2,
    title: `Task ${id}`,
    project_title: 'Launch',
    project_color: null,
    due_date: due,
    status: 'todo',
  }) as MyTask;

describe('the widgets’ snapshot', () => {
  const snapshot = buildSnapshot({
    station: { id: 'local-3993', name: 'Local' },
    lang: 'zh',
    myTasks: [
      { bucket: 'overdue', tasks: [task(1, '2026-10-20')] },
      { bucket: 'soon', tasks: [task(2, '2026-10-26T09:00:00Z'), task(3, '2026-10-27'), task(4, '2026-10-28')] },
    ],
    recentDocs: [
      { id: 7, title: 'Brand Voice', openedAt: 1_800_000_000_000 },
      { id: 8, title: 'FAQ', openedAt: 1_700_000_000_000 },
      { id: 9, title: 'Handbook', openedAt: 1 },
      { id: 10, title: 'Old', openedAt: 0 },
    ],
    now: 1_800_000_001_000,
  });

  it('shows the next three tasks due and the three documents opened last', () => {
    expect(snapshot.tasks.map((t) => [t.title, t.due, t.bucket])).toEqual([
      ['Task 1', '2026-10-20', 'overdue'],
      ['Task 2', '2026-10-26', 'soon'],
      ['Task 3', '2026-10-27', 'soon'],
    ]);
    expect(snapshot.docs.map((d) => d.title)).toEqual(['Brand Voice', 'FAQ', 'Handbook']);
    expect(snapshot.docs[0]!.openedAt).toBe(1_800_000_000);
  });

  it('links each item on its station and carries nothing secret', () => {
    expect(snapshot.tasks[0]!.url).toBe('greenhouse://projects/task?project=2&task=1&station=local-3993');
    expect(snapshot.docs[0]!.url).toBe('greenhouse://knowledge/doc?id=7&station=local-3993');
    expect(Object.keys(snapshot).sort()).toEqual(['docs', 'lang', 'stationName', 'tasks', 'updatedAt', 'v']);
    expect(JSON.stringify(snapshot)).not.toMatch(/token|usr_/i);
  });

  it('is empty without copies', () => {
    const empty = buildSnapshot({ station: { id: 's', name: 'S' }, lang: 'en', myTasks: null, recentDocs: [], now: 0 });
    expect(empty.tasks).toEqual([]);
    expect(empty.docs).toEqual([]);
  });
});

describe('the foreground refresh of my tasks for the widget', () => {
  it('saves the station’s answer', () => {
    expect(myTasksRefreshAction({ ok: true })).toBe('save');
  });

  it('deletes the copy when the station says it is gone or no longer mine, so the widget empties', () => {
    for (const status of [403, 404, 410]) expect(myTasksRefreshAction({ ok: false, status })).toBe('delete');
  });

  it('keeps the copy on any other miss', () => {
    for (const status of [0, 500, 502, 503, 504, 429]) expect(myTasksRefreshAction({ ok: false, status })).toBe('keep');
  });
});

describe('a widget link opening the app', () => {
  it('opens the item on the station it came from', () => {
    expect(widgetLinkPath('greenhouse://projects/task?project=2&task=1&station=local-3993', 'local-3993')).toBe(
      '/sheet/task?project=2&id=1',
    );
    expect(widgetLinkPath('/knowledge/doc?id=7&station=local-3993', 'local-3993')).toBe('/sheet/doc?id=7');
  });

  it('keeps the station on an item from another station, so the item says it is not here', () => {
    expect(widgetLinkPath('greenhouse://knowledge/doc?id=7&station=other', 'local-3993')).toBe('/sheet/doc?id=7&station=other');
  });

  it('goes home for anything with a station that is not a widget item', () => {
    expect(widgetLinkPath('greenhouse://settings?station=local-3993', 'local-3993')).toBe('/');
  });

  it('keeps the station on a cold start, before the active station is read', () => {
    expect(widgetLinkPath('greenhouse://knowledge/doc?id=7&station=local-3993', null)).toBe('/sheet/doc?id=7&station=local-3993');
    expect(widgetLinkPath('greenhouse://projects/task?project=2&task=1&station=other', null)).toBe(
      '/sheet/task?project=2&id=1&station=other',
    );
  });

  it('leaves other links alone', () => {
    expect(widgetLinkPath('/tables/record?table=1&id=2', 'local-3993')).toBe('/tables/record?table=1&id=2');
    expect(widgetLinkPath('greenhouse://auth/feishu?feishu_code=x', 'local-3993')).toBe('greenhouse://auth/feishu?feishu_code=x');
  });
});

describe('which links open a widget item', () => {
  it('are the task and document sheets', () => {
    expect(isWidgetItemPath('/sheet/task?project=2&id=16')).toBe(true);
    expect(isWidgetItemPath('/sheet/doc?id=7&station=other')).toBe(true);
    expect(isWidgetItemPath('/sheet/doc')).toBe(true);
  });

  it('are not home, other pages or sign-in callbacks', () => {
    for (const path of ['/', '/projects', '/sheet/taskboard', '/knowledge', '/sheet/project?id=1', 'greenhouse://auth/feishu?feishu_code=x', '/tables/record?table=1&id=2']) {
      expect(isWidgetItemPath(path)).toBe(false);
    }
  });
});

describe('a screen opened from a widget link', () => {
  it('waits until the stations are read', () => {
    expect(widgetStationGate('local-3993', { hydrated: false, activeId: null })).toBe('wait');
    expect(widgetStationGate('local-3993', { hydrated: false, activeId: 'local-3993' })).toBe('wait');
  });

  it('opens on the station the link came from', () => {
    expect(widgetStationGate('local-3993', { hydrated: true, activeId: 'local-3993' })).toBe('open');
  });

  it('never opens on another station, or with none', () => {
    expect(widgetStationGate('other', { hydrated: true, activeId: 'local-3993' })).toBe('elsewhere');
    expect(widgetStationGate('other', { hydrated: true, activeId: null })).toBe('elsewhere');
  });

  it('opens links that name no station as before', () => {
    expect(widgetStationGate(undefined, { hydrated: false, activeId: null })).toBe('open');
    expect(widgetStationGate('', { hydrated: true, activeId: 'x' })).toBe('open');
  });
});

describe('the widget and the bridge read the same snapshot', () => {
  it('use one App Group key, and the widget decodes every field the app writes', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const widget = read('../../targets/widget/index.swift');
    const bridge = read('../../modules/widget-bridge/ios/WidgetBridgeModule.swift');
    const key = (source: string) => /snapshotKey = "([^"]+)"/.exec(source)?.[1];
    expect(key(widget)).toBeDefined();
    expect(key(widget)).toBe(key(bridge));
    const snapshot = buildSnapshot({
      station: { id: 's', name: 'S' },
      lang: 'en',
      myTasks: [{ bucket: 'today', tasks: [task(1, '2026-10-24')] }],
      recentDocs: [{ id: 1, title: 'Doc', openedAt: 1 }],
      now: 0,
    });
    const fields = (struct: string) =>
      [...(new RegExp(`struct ${struct}: Decodable[^{]*\\{([^}]*)\\}`).exec(widget)?.[1] ?? '').matchAll(/let (\w+):/g)].map((m) => m[1]).sort();
    expect(fields('WidgetSnapshot')).toEqual(Object.keys(snapshot).sort());
    expect(fields('WidgetTask')).toEqual(Object.keys(snapshot.tasks[0]!).sort());
    expect(fields('WidgetDoc')).toEqual(Object.keys(snapshot.docs[0]!).sort());
  });
});
