/**
 * Background tasks of a Bots conversation, in the Task Dock above the
 * composer — "instruments in the Dock, deliverables in the message flow".
 * The task's report arrives as a Bot message; this row only shows progress
 * and offers Cancel.
 *
 * The row shell is the chat Task Dock's own DockRow (same look, same persisted
 * open state under `task-dock-open:bot-tasks`).
 */

import { useCallback, useEffect, useState } from 'react';
import type { BotTaskView } from '@greenhouse/types/bots';
import { IconButton, Tag, toast, type TagTone } from '../ui';
import { ListTodo, X } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { wsClient } from '../../lib/ws';
import * as botsApi from '../../lib/api/bots';
import { DockRow } from '../conversation/task-dock';
import { BotAvatar } from './bot-avatar';
import type { BotLookup } from './transcript-rows';

const ACTIVE: ReadonlySet<BotTaskView['status']> = new Set(['queued', 'running', 'waiting']);
const POLL_MS = 15_000;

const STATUS_TONE: Record<BotTaskView['status'], TagTone> = {
  queued: 'neutral',
  running: 'primary',
  waiting: 'warning',
  succeeded: 'success',
  failed: 'danger',
  canceled: 'neutral',
  interrupted: 'warning',
};

function elapsed(task: BotTaskView, now: number): string {
  const start = task.started_at ?? task.created_at;
  const end = task.ended_at ? Date.parse(task.ended_at) : now;
  const seconds = Math.max(0, Math.round((end - Date.parse(start)) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function useBotTasks(sessionId: string) {
  const [tasks, setTasks] = useState<BotTaskView[]>([]);
  const refresh = useCallback(async () => {
    try {
      const { tasks: next } = await botsApi.listConversationTasks(sessionId);
      setTasks(next);
    } catch {
      // The dock is an instrument; a failed refresh keeps the last known rows.
    }
  }, [sessionId]);

  useEffect(() => {
    setTasks([]);
    void refresh();
  }, [refresh]);

  useEffect(
    () =>
      wsClient.onEvent((event) => {
        if (event.type === 'bots:conversation' && event.sessionId === sessionId) void refresh();
        if (event.type === 'runtime:invalidate' && tasks.some((task) => task.run_id === event.runId)) void refresh();
      }),
    [refresh, sessionId, tasks],
  );

  const anyActive = tasks.some((task) => ACTIVE.has(task.status));
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, refresh]);

  return { tasks, refresh };
}

export function BotTaskDock({
  tasks,
  lookup,
  onChanged,
}: {
  tasks: BotTaskView[];
  lookup: BotLookup;
  onChanged: () => void;
}) {
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  const [canceling, setCanceling] = useState<string | null>(null);
  const active = tasks.filter((task) => ACTIVE.has(task.status));

  useEffect(() => {
    if (active.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active.length]);

  // Finished tasks stay in the dock only while something else is still running;
  // their outcome lives in the transcript.
  const visible = active.length > 0 ? tasks : [];
  if (visible.length === 0) return null;
  const done = visible.length - active.length;

  const cancel = async (task: BotTaskView) => {
    setCanceling(task.run_id);
    try {
      await botsApi.cancelBotTask(task.run_id);
      toast(t('bots.tasks.canceledToast'), 'success');
      onChanged();
    } catch {
      toast(t('bots.tasks.cancelFailed'), 'error');
    } finally {
      setCanceling(null);
    }
  };

  return (
    <div className="relative z-0 -mb-1 translate-y-0.5 space-y-2" data-testid="bots-task-dock">
      <DockRow
        kind="bot-tasks"
        testId="bots-task-dock-row"
        icon={<ListTodo size={14} className="flex-shrink-0 text-fg-muted" />}
        spinning={active.length > 0}
        name={t('bots.tasks.title')}
        meta={
          <span className="flex-shrink-0 text-[10px] text-fg-faint">
            {t('bots.tasks.active', { count: active.length })}
            {done > 0 ? ` · ${t('bots.tasks.summary', { done, total: visible.length })}` : ''}
          </span>
        }
        tone="bg-surface-sunken"
        toggleLabel={t('bots.tasks.toggle')}
      >
        <ul className="divide-y divide-edge">
          {visible.map((task) => {
            const bot = lookup(task.bot_id);
            const isActive = ACTIVE.has(task.status);
            return (
              <li key={task.run_id} className="flex items-center gap-2 py-2">
                {bot ? <BotAvatar bot={bot} size="xs" /> : <ListTodo size={14} className="text-fg-muted" />}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-fg" title={task.title}>
                    {task.title}
                  </span>
                  {task.summary && (
                    <span className="block truncate text-[10px] text-fg-faint" title={task.summary}>
                      {task.summary}
                    </span>
                  )}
                </span>
                <span className="flex-shrink-0 text-[10px] tabular-nums text-fg-faint">{elapsed(task, now)}</span>
                <Tag tone={STATUS_TONE[task.status]}>{t(`bots.tasks.${task.status}` as TranslationKey)}</Tag>
                {isActive && (
                  <IconButton
                    size="compact"
                    label={t('bots.tasks.cancel')}
                    disabled={canceling === task.run_id}
                    onClick={() => void cancel(task)}
                    tooltip="top"
                  >
                    <X size={13} />
                  </IconButton>
                )}
              </li>
            );
          })}
        </ul>
      </DockRow>
    </div>
  );
}
