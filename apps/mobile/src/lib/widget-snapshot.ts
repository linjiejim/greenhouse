/**
 * Home-screen widget data snapshot — SCHEMA TRUTH SOURCE.
 *
 * Built from the tasks + sessions APIs and published to the App Group via the
 * WidgetBridge native module (modules/widget-bridge). The Swift `Snapshot`
 * Codable in targets/widget/index.swift decodes exactly this shape — change
 * them together (bump `v` on breaking changes; the widget ignores snapshots
 * with a newer `v` and falls back to launcher-only mode).
 *
 * Refresh timing (wired in app/_layout.tsx): after login bootstrap resolves,
 * and whenever the app goes to background. Timestamps are epoch millis —
 * parsed on the RN side with parseMs() (Hermes can't parse PG timestamps).
 */

import { Platform } from 'react-native';
import { setWidgetSnapshot } from '../../modules/widget-bridge';
import { listSessions } from '../api/sessions';
import { listTasks } from '../api/tasks';
import { parseMs } from './format';
import type { LangPref } from '../store/prefs';

const SNAPSHOT_VERSION = 1;
const MAX_TASKS = 3;
const MAX_SESSIONS = 2;

interface WidgetTask {
  name: string;
  lastStatus: 'completed' | 'failed' | 'running' | null;
  lastRunAt: number | null;
  nextRunAt: number | null;
}
interface WidgetSession {
  id: string;
  title: string;
  updatedAt: number | null;
}
export interface WidgetSnapshot {
  v: number;
  updatedAt: number;
  nickname: string;
  lang: LangPref;
  tasks: WidgetTask[];
  sessions: WidgetSession[];
}

function msOrNull(iso: string | null | undefined): number | null {
  const t = parseMs(iso);
  return Number.isNaN(t) ? null : t;
}

/** Fetch fresh data and publish it to the widget. Failures keep the last snapshot. */
export async function refreshWidgetSnapshot(nickname: string, lang: LangPref): Promise<void> {
  if (Platform.OS !== 'ios') return;
  try {
    const [tasks, sessions] = await Promise.all([listTasks(), listSessions({ limit: 10 })]);
    const snapshot: WidgetSnapshot = {
      v: SNAPSHOT_VERSION,
      updatedAt: Date.now(),
      nickname,
      lang,
      tasks: tasks
        .filter((t) => t.enabled)
        .slice(0, MAX_TASKS)
        .map((t) => ({
          name: t.name,
          lastStatus: t.last_status,
          lastRunAt: msOrNull(t.last_run_at),
          nextRunAt: msOrNull(t.next_run_at),
        })),
      sessions: sessions
        .filter((s) => s.is_owner !== false)
        .slice(0, MAX_SESSIONS)
        .map((s) => ({
          id: s.id,
          title: s.title || '',
          updatedAt: msOrNull(s.updated_at),
        })),
    };
    setWidgetSnapshot(JSON.stringify(snapshot));
  } catch {
    // Widget keeps showing the previous snapshot; never surface this to the UI.
  }
}

/** Drop the snapshot (logout) — the widget falls back to launcher-only mode. */
export function clearWidgetSnapshot(): void {
  if (Platform.OS !== 'ios') return;
  setWidgetSnapshot(null);
}
