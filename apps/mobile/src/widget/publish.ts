/**
 * Keeps the home-screen widgets (targets/widget) in step with the app: whenever my tasks or the
 * recently opened documents change on the phone, the station or member changes, or the language
 * changes, the snapshot (./model.ts) is rebuilt from the offline copies and published into the
 * App Group. Signed out, it is cleared. When the app comes to the foreground it refreshes my tasks
 * (at most every 10 minutes) so the widget's "next due" stays current; a 403 / 404 / 410 deletes
 * the copy and the widget shows no tasks. Imported once by the root
 * layout.
 */

import { AppState } from 'react-native';
import { setWidgetSnapshot } from '../../modules/widget-bridge';
import { gantt } from '../api/projects';
import { captureIdentity } from '../data/identity';
import { parseMyTasks } from '../data/recent-items';
import { localDay, myTasks } from '../data/tasks';
import { useAuth } from '../store/auth';
import { recentDocs } from '../store/knowledge';
import { readOffline, removeOffline, writeOffline } from '../store/offline';
import { onOfflineChanged } from '../store/offline-events';
import { usePrefs } from '../store/prefs';
import { getActiveStation, useStations } from '../store/stations';
import { buildSnapshot, myTasksRefreshAction } from './model';

const REFRESH_MS = 10 * 60_000;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastRefresh = 0;
let lastIdentity = '';

async function publish(): Promise<void> {
  const station = getActiveStation();
  const user = useAuth.getState().user;
  if (!station || !user) {
    setWidgetSnapshot(null);
    return;
  }
  const current = captureIdentity();
  const [tasks, docs] = await Promise.all([readOffline('my-tasks'), recentDocs()]);
  if (!current()) return;
  const snapshot = buildSnapshot({
    station: { id: station.id, name: station.name },
    lang: usePrefs.getState().lang,
    myTasks: parseMyTasks(tasks),
    recentDocs: docs,
    now: Date.now(),
  });
  setWidgetSnapshot(JSON.stringify(snapshot));
}

/** Rebuild soon (several changes in a row publish once). */
export function scheduleWidget(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void publish();
  }, 300);
}

/** Read my tasks for the widget when the copy is older than 10 minutes. */
async function refreshMyTasks(): Promise<void> {
  if (!useAuth.getState().user || Date.now() - lastRefresh < REFRESH_MS) return;
  lastRefresh = Date.now();
  const current = captureIdentity();
  const result = await gantt();
  if (!current()) return;
  const action = myTasksRefreshAction(result);
  // deleting notifies onOfflineChanged, which republishes the widget without tasks
  if (action === 'delete') removeOffline('my-tasks');
  if (action === 'save' && result.ok)
    writeOffline('my-tasks', myTasks(result.data.projects, useAuth.getState().user?.id ?? '', localDay(new Date())));
}

onOfflineChanged((kind) => {
  if (kind === 'my-tasks' || kind === 'kb-recent') scheduleWidget();
});

function onIdentity(): void {
  const identity = `${useStations.getState().activeId ?? ''}|${useAuth.getState().user?.id ?? ''}`;
  if (identity === lastIdentity) return;
  lastIdentity = identity;
  lastRefresh = 0;
  scheduleWidget();
  void refreshMyTasks();
}

useAuth.subscribe(onIdentity);
useStations.subscribe(onIdentity);
usePrefs.subscribe(scheduleWidget);
AppState.addEventListener('change', (state) => {
  if (state === 'active') void refreshMyTasks();
});
