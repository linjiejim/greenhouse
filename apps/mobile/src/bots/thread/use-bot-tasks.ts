/**
 * A thread's background tasks for the task dock (./task-dock.tsx):
 * `GET /api/bots/conversations/:sid/tasks`, refreshed when the thread opens,
 * when its transcript gains a task row (a task started or reported — the
 * caller passes the count), on `bots:conversation` for this thread and on a
 * WS resync, and when the app comes back to the foreground. With the socket
 * up nothing polls; without it, the thread's slow beat (24 s) refreshes while
 * a task is active (spec §2.5.3 h, §2.7.3). A failed refresh keeps the last
 * known rows — the dock is an instrument, its outcome lives in the transcript.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { listConversationTasks } from '../../api/bots';
import { realtime } from '../../realtime';
import type { BotTaskView } from '../../shared/bots';
import { ACTIVE } from '../vendor/web-helpers';

/** The thread's no-socket reload beat (spec §2.7.3). */
const POLL_MS = 24_000;

export function useBotTasks(
  sessionId: string,
  {
    enabled,
    taskRows,
  }: {
    /** Off until the thread has loaded (and in a read-only state that can't have tasks running). */
    enabled: boolean;
    /** Task rows in the loaded transcript (`task_started` / `task_report`) — a change refreshes. */
    taskRows: number;
  },
): { tasks: BotTaskView[]; active: BotTaskView[]; refresh(): Promise<void> } {
  const [tasks, setTasks] = useState<BotTaskView[]>([]);
  // Answers to an older request are dropped (two refreshes in flight).
  const ticket = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++ticket.current;
    const res = await listConversationTasks(sessionId);
    if (res.ok && mine === ticket.current) setTasks(res.value);
  }, [sessionId]);

  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh, taskRows]);

  useEffect(() => {
    if (!enabled) return;
    const off = realtime.on((e) => {
      if (e.type === 'resync' || (e.type === 'bots:conversation' && e.sessionId === sessionId)) void refresh();
    });
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void refresh();
    });
    return () => {
      off();
      sub.remove();
    };
  }, [enabled, refresh, sessionId]);

  const active = useMemo(() => tasks.filter((task) => ACTIVE.has(task.status)), [tasks]);
  const anyActive = active.length > 0;
  useEffect(() => {
    if (!enabled || !anyActive) return;
    const timer = setInterval(() => {
      if (realtime.status !== 'open') void refresh();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, anyActive, refresh]);

  return { tasks, active, refresh };
}
