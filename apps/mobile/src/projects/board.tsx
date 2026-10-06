/**
 * BoardView — kanban lanes (one per task status) as horizontally snapping
 * columns; each lane scrolls its own cards. Web drags cards between columns —
 * on touch, status moves go through the card's long-press system menu
 * (状态 submenu) instead, and tapping a card opens the task. With write
 * access each lane header carries a `+` that opens the task form preset to
 * that status (web board parity: per-column add). VoiceOver: a card is one
 * element with open / mark-done as accessibility actions.
 *
 * Surfaces follow iOS layering: lanes are a `secondaryBackground` well, cards
 * sit on `tertiaryBackground` (white in light, raised gray in dark).
 */

import React, { useMemo } from 'react';
import { FlatList, Pressable, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import type { ProjectTask, TaskStatus } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon } from '../ui/core';
import { InitialAvatar } from '../ui/avatar';
import { NativeMenu } from '../ui/menu';
import { TASK_STATUSES, forEachTask, taskStatusColor, taskStatusIcon, taskStatusLabel } from './meta';
import { TaskMeta, TaskStatusButton, taskRowA11y } from './task-list';
import type { useTaskActions } from './task-actions';

type TaskActions = ReturnType<typeof useTaskActions>;

const LANE_GAP = space.md;

export function BoardView({
  tasks,
  actions,
  canWrite,
  onAdd,
  bottomInset = 0,
}: {
  /** Task tree — flattened internally (the board shows every task). */
  tasks: ProjectTask[];
  actions: TaskActions;
  canWrite: boolean;
  /** New task in a lane (shown only with write access). */
  onAdd?: (status: TaskStatus) => void;
  /** Space under the lanes (home indicator). */
  bottomInset?: number;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { width } = useWindowDimensions();
  const laneW = Math.min(320, Math.round(width * 0.78));

  const byStatus = useMemo(() => {
    const map = new Map<TaskStatus, ProjectTask[]>(TASK_STATUSES.map((s) => [s, []]));
    forEachTask(tasks, (task) => map.get(task.status)?.push(task));
    return map;
  }, [tasks]);

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      snapToInterval={laneW + LANE_GAP}
      decelerationRate="fast"
      contentContainerStyle={[styles.lanes, { paddingBottom: Math.max(space.lg, bottomInset) }]}
    >
      {TASK_STATUSES.map((status) => {
        const items = byStatus.get(status) ?? [];
        return (
          <View key={status} style={[styles.lane, { width: laneW }]}>
            <View style={styles.laneHeader}>
              <Icon name={taskStatusIcon(status)} size={17} color={taskStatusColor(status, c)} />
              <Text style={styles.laneTitle}>{taskStatusLabel(status, t)}</Text>
              <Text style={styles.laneCount}>{items.length}</Text>
              {canWrite && onAdd ? (
                <Pressable
                  onPress={() => onAdd(status)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('projects.newTaskIn', { status: taskStatusLabel(status, t) })}
                  style={({ pressed }) => [styles.laneAdd, pressed && { opacity: 0.5 }]}
                >
                  <Icon name="plus" size={17} weight="semibold" color={c.accent} />
                </Pressable>
              ) : null}
            </View>
            <FlatList
              data={items}
              keyExtractor={(task) => String(task.id)}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.laneBody}
              ListEmptyComponent={<View style={styles.laneEmpty} />}
              renderItem={({ item }) => <BoardCard task={item} actions={actions} canWrite={canWrite} />}
            />
          </View>
        );
      })}
    </ScrollView>
  );
}

function BoardCard({ task, actions, canWrite }: { task: ProjectTask; actions: TaskActions; canWrite: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const closed = task.status === 'done' || task.status === 'cancelled';
  const card = (
    <Pressable
      onPress={() => actions.open(task)}
      {...taskRowA11y(task, t, { actions, canWrite })}
      style={({ pressed }) => [styles.card, pressed && { opacity: 0.7 }]}
    >
      <View style={styles.cardTop}>
        <TaskStatusButton
          task={task}
          size={20}
          onToggle={canWrite ? () => void actions.setStatus(task, task.status === 'done' ? 'todo' : 'done') : undefined}
        />
        <Text numberOfLines={3} style={[styles.cardTitle, closed && styles.cardTitleClosed]}>
          {task.title}
        </Text>
        {task.assignee_nickname ? <InitialAvatar name={task.assignee_nickname} size={22} tint={c.gray} /> : null}
      </View>
      <View style={styles.cardMeta}>
        <TaskMeta task={task} />
      </View>
    </Pressable>
  );
  if (!canWrite) return card;
  return (
    <NativeMenu trigger="longPress" items={actions.menuItems(task)} onSelect={(id) => actions.onSelect(task, id)}>
      {card}
    </NativeMenu>
  );
}

const useStyles = makeStyles((c) => ({
  lanes: { paddingHorizontal: space.margin, gap: LANE_GAP, flexGrow: 1 },
  lane: { flex: 1, backgroundColor: c.secondaryBackground, borderRadius: radius.xl, ...squircle, overflow: 'hidden' },
  laneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.md + 2,
    paddingTop: space.md + 2,
    paddingBottom: space.sm,
  },
  laneTitle: { ...typo.headline, color: c.label, flex: 1 },
  laneCount: { ...typo.subheadline, fontWeight: weight.semibold, color: c.secondaryLabel, fontVariant: ['tabular-nums'] },
  laneAdd: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginRight: -space.xs },
  laneBody: { gap: space.sm, paddingHorizontal: space.sm, paddingBottom: space.xxl, flexGrow: 1 },
  laneEmpty: {
    height: 64,
    marginHorizontal: space.xs,
    borderRadius: radius.lg,
    ...squircle,
    borderWidth: 1.5,
    borderColor: c.separator,
    borderStyle: 'dashed',
  },
  card: {
    backgroundColor: c.tertiaryBackground,
    borderRadius: radius.lg,
    ...squircle,
    paddingHorizontal: space.md,
    paddingVertical: space.md - 2,
    gap: space.xs,
  },
  cardTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  cardTitle: { ...typo.subheadline, fontWeight: weight.medium, color: c.label, flex: 1, paddingTop: 1 },
  cardTitleClosed: { color: c.secondaryLabel, textDecorationLine: 'line-through' },
  cardMeta: { paddingLeft: 20 + space.sm },
}));
