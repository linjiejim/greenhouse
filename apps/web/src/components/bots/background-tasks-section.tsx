/**
 * The conversations sidebar's "Background" group (spec 20261011-agent-first-class §3.1, D15):
 * the background tasks the member's Agents run, across every thread — live ones first, then
 * the last few that ended. A row opens the thread that started the task, where its progress
 * dock and its report live; this group only makes the work visible from anywhere.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BotTaskView } from '@greenhouse/types/bots';
import { Tag } from '../ui';
import { ListTodo } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { wsClient } from '../../lib/ws';
import * as botsApi from '../../lib/api/bots';
import { SidebarSectionLabel } from '../app/sidebar-section-label';
import { BotAvatar } from './bot-avatar';
import { ACTIVE_TASK_STATUSES, TASK_POSE, TASK_STATUS_TONE } from './bot-task-dock';
import { useBotDirectory } from './bots-store';
import { openBotsConversation } from './navigation';

type MemberTask = BotTaskView & { session_id: string };

const POLL_MS = 15_000;
/** One refresh for a burst of thread events (a turn ending, a card, a report land together). */
const EVENT_DEBOUNCE_MS = 1_000;
/** Ended tasks shown under the live ones; older ones are in the threads and the Execution Center. */
const RECENT_ENDED = 3;

export function useMemberTasks(): { tasks: MemberTask[]; refresh: () => Promise<void> } {
  const [tasks, setTasks] = useState<MemberTask[]>([]);
  const refresh = useCallback(async () => {
    try {
      setTasks((await botsApi.listMemberTasks()).tasks);
    } catch {
      // A sidebar instrument: a failed refresh keeps the last known rows.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const soon = () => {
      if (pending.current) clearTimeout(pending.current);
      pending.current = setTimeout(() => void refresh(), EVENT_DEBOUNCE_MS);
    };
    const off = wsClient.onEvent((event) => {
      // A task starts or reports in a thread (bots:conversation); its Run moves (runtime:invalidate).
      if (event.type === 'bots:conversation') soon();
      if (event.type === 'runtime:invalidate' && tasks.some((task) => task.run_id === event.runId)) soon();
    });
    return () => {
      off();
      if (pending.current) clearTimeout(pending.current);
    };
  }, [refresh, tasks]);

  const anyActive = tasks.some((task) => ACTIVE_TASK_STATUSES.has(task.status));
  useEffect(() => {
    if (!anyActive) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [anyActive, refresh]);

  return { tasks, refresh };
}

export function BackgroundTasksSection({ query, onNavigate }: { query: string; onNavigate?: () => void }) {
  const t = useT();
  const { tasks } = useMemberTasks();
  const lookup = useBotDirectory();

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    const matching = needle
      ? tasks.filter((task) =>
          [task.title, task.summary ?? '', lookup.get(task.bot_id)?.name ?? ''].some((text) =>
            text.toLocaleLowerCase().includes(needle),
          ),
        )
      : tasks;
    const live = matching.filter((task) => ACTIVE_TASK_STATUSES.has(task.status));
    const ended = matching.filter((task) => !ACTIVE_TASK_STATUSES.has(task.status)).slice(0, RECENT_ENDED);
    return [...live, ...ended];
  }, [lookup, query, tasks]);

  if (visible.length === 0) return null;

  return (
    <div className="px-1 pb-1" data-testid="sidebar-background-tasks">
      <SidebarSectionLabel testId="sidebar-section-background">{t('bots.sidebar.background')}</SidebarSectionLabel>
      {visible.map((task) => {
        const bot = lookup.get(task.bot_id);
        return (
          <button
            key={task.run_id}
            type="button"
            onClick={() => {
              openBotsConversation(task.session_id);
              onNavigate?.();
            }}
            // Never "active": a task is not a conversation — the thread it came from is the
            // highlighted row above, and every task of that thread would light up with it.
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-muted"
            data-testid="sidebar-background-task"
            data-run-id={task.run_id}
          >
            <span className="flex w-[42px] flex-shrink-0 justify-center">
              {bot ? (
                // The row prints the task, so the Agent's name is the avatar's label; its static
                // pose tells the outcome (the dock's TASK_POSE).
                <BotAvatar bot={bot} size="xs" state={TASK_POSE[task.status]} animate={false} label={bot.name} />
              ) : (
                <ListTodo size={14} className="text-fg-muted" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs font-medium text-fg-secondary" title={task.title}>
                {task.title}
              </span>
              <span className="block truncate text-[11px] text-fg-faint">
                {bot ? t('bots.sidebar.backgroundFrom', { name: bot.name }) : t('bots.tasks.title')}
              </span>
            </span>
            <Tag tone={TASK_STATUS_TONE[task.status]}>{t(`bots.tasks.${task.status}` as TranslationKey)}</Tag>
          </button>
        );
      })}
    </div>
  );
}
