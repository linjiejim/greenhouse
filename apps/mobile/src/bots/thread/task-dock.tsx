/**
 * The task dock — background work in this conversation, as a glass capsule
 * above the input row ("instruments in the dock, deliverables in the message
 * flow", web bot-task-dock.tsx): one active task reads "(🌿) Meeting notes ·
 * 2m 31s", several "3 background tasks running". Shown only while something
 * is queued / running / waiting; the report itself arrives as a message.
 *
 * A tap opens a system menu: each task (title · status · elapsed) with
 * "Cancel Task" inside — confirmed, then `POST /api/bots/tasks/:id/cancel`;
 * a task that already finished (409) just refreshes. The clock ticks once a
 * second and only re-renders the dock. Owner poses are static (TASK_POSE).
 * The running time is localized (./task-elapsed.ts — the web's `elapsed()`
 * bakes in English unit letters): compact on screen, whole words for
 * VoiceOver.
 */

import React, { memo, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { cancelBotTask } from '../../api/bots';
import { useT, type TFunction, type TranslationKey } from '../../lib/i18n';
import type { BotTaskView, BotView } from '../../shared/bots';
import { HIT, makeStyles, space, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { alertError, confirmAction } from '../../ui/dialogs';
import { Glass } from '../../ui/glass';
import { NativeMenu, type MenuItem } from '../../ui/menu';
import { toast } from '../../ui/toast';
import { AvatarStack } from '../ui/avatar-stack';
import { BotAvatar } from '../ui/bot-avatar';
import { TASK_POSE } from '../vendor/web-helpers';
import { elapsedCompact, elapsedSpoken, taskSeconds } from './task-elapsed';

const STATUS_KEY: Partial<Record<BotTaskView['status'], TranslationKey>> = {
  queued: 'bots.thread.taskQueued',
  running: 'bots.thread.taskRunning',
  waiting: 'bots.thread.taskWaiting',
};

/** "2m 31s" / "2分31秒" — the clock and the menu. */
function compact(t: TFunction, task: BotTaskView, now: number): string {
  const { key, vars } = elapsedCompact(taskSeconds(task, now));
  return t(key, vars);
}

/** "2 minutes 31 seconds" / "2 分钟 31 秒" — what VoiceOver says. */
function spoken(t: TFunction, task: BotTaskView, now: number): string {
  return elapsedSpoken(taskSeconds(task, now))
    .map(({ key, vars }) => t(key, vars))
    .join(' ');
}

export const TaskDock = memo(function TaskDock({
  active,
  byId,
  onChanged,
}: {
  /** The active tasks (queued / running / waiting), oldest first. */
  active: BotTaskView[];
  byId: Record<string, BotView>;
  /** A cancel went through (or the task had already finished): refresh. */
  onChanged: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const items = useMemo<MenuItem[]>(
    () =>
      active.map((task) => ({
        id: task.run_id,
        title: t('bots.thread.taskMenu', {
          title: task.title,
          status: t(STATUS_KEY[task.status] ?? 'bots.thread.taskRunning'),
          elapsed: compact(t, task, now),
        }),
        icon: 'hourglass',
        children: [{ id: `cancel:${task.run_id}`, title: t('bots.thread.cancelTask'), icon: 'x', destructive: true }],
      })),
    [active, now, t],
  );

  const cancel = async (runId: string) => {
    const task = active.find((x) => x.run_id === runId);
    if (!task) return;
    const ok = await confirmAction({
      title: t('bots.thread.cancelTaskConfirm', { title: task.title }),
      confirmLabel: t('bots.thread.cancelTask'),
      destructive: true,
    });
    if (!ok) return;
    const res = await cancelBotTask(runId);
    if (res.ok) toast(t('bots.thread.taskCanceled'), 'check');
    else if (res.status !== 409) alertError(t('bots.thread.cancelFailed'), res.message || undefined);
    onChanged();
  };

  const first = active[0];
  if (!first) return null;
  const several = active.length > 1;
  const label = several
    ? t('bots.thread.tasksN', { n: active.length })
    : t('bots.thread.task', { title: first.title, elapsed: spoken(t, first, now) });
  const owners = [...new Set(active.map((task) => task.bot_id))].map((id) => byId[id] ?? null);
  return (
    <NativeMenu
      items={items}
      fill
      onSelect={(id) => {
        if (id.startsWith('cancel:')) void cancel(id.slice('cancel:'.length));
      }}
    >
      <Glass interactive style={styles.capsule}>
        <View style={styles.row} accessible accessibilityRole="button" accessibilityLabel={label}>
          {several ? (
            <AvatarStack bots={owners} size={20} />
          ) : (
            <BotAvatar bot={byId[first.bot_id] ?? null} size={22} state={TASK_POSE[first.status]} animate={false} />
          )}
          {several ? (
            <Text numberOfLines={1} style={styles.title}>
              {label}
            </Text>
          ) : (
            <>
              <Text numberOfLines={1} style={styles.title}>
                {first.title}
              </Text>
              <Text style={styles.clock}>{compact(t, first, now)}</Text>
            </>
          )}
          <Icon name="chevUpDown" size={11} weight="semibold" color={c.tertiaryLabel} />
        </View>
      </Glass>
    </NativeMenu>
  );
});

const useStyles = makeStyles((c) => ({
  capsule: { minHeight: HIT - 6, borderRadius: (HIT - 6) / 2, justifyContent: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT - 6,
    paddingHorizontal: space.md,
  },
  title: { flex: 1, ...typo.subheadline, fontWeight: weight.medium, color: c.label },
  clock: { ...typo.footnote, color: c.secondaryLabel, fontVariant: ['tabular-nums'] },
}));
