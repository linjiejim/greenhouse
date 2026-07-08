/**
 * BoardView — kanban columns (one per task status) as horizontally snapping
 * lanes; each lane scrolls its own cards. Web drags cards between columns —
 * on touch, status moves go through the long-press action sheet instead.
 */

import React, { useMemo } from 'react';
import { FlatList, ScrollView, Text, useWindowDimensions, View } from 'react-native';
import type { ProjectTask, TaskStatus } from '../shared/greenhouse-types';
import { useT } from '../lib/i18n';
import { Icon, Touchable } from '../ui';
import { font, makeStyles, radius, useTheme, weight } from '../theme';
import {
  TASK_STATUSES,
  forEachTask,
  isOverdue,
  priorityColor,
  shortDate,
  taskStatusColor,
  taskStatusIcon,
  taskStatusLabel,
  taskStatusTint,
} from './meta';

const LANE_GAP = 10;

export function BoardView({
  tasks,
  onOpen,
  onLongPress,
}: {
  /** Task tree — flattened internally (board shows every task). */
  tasks: ProjectTask[];
  onOpen: (task: ProjectTask) => void;
  onLongPress: (task: ProjectTask) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const { width } = useWindowDimensions();
  const laneW = Math.min(300, Math.round(width * 0.74));

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
      contentContainerStyle={styles.lanes}
    >
      {TASK_STATUSES.map((status) => {
        const items = byStatus.get(status) ?? [];
        return (
          <View key={status} style={[styles.lane, { width: laneW }]}>
            <View style={[styles.laneHeader, { backgroundColor: taskStatusTint(status, c) }]}>
              <Icon name={taskStatusIcon(status)} size={14} color={taskStatusColor(status, c)} />
              <Text style={[styles.laneTitle, { color: taskStatusColor(status, c) }]}>{taskStatusLabel(status, t)}</Text>
              <Text style={styles.laneCount}>{items.length}</Text>
            </View>
            <FlatList
              data={items}
              keyExtractor={(task) => String(task.id)}
              showsVerticalScrollIndicator={false}
              contentContainerStyle={{ gap: 8, paddingBottom: 100, flexGrow: 1 }}
              ListEmptyComponent={<View style={styles.laneEmpty} />}
              renderItem={({ item }) => (
                <BoardCard task={item} onPress={() => onOpen(item)} onLongPress={() => onLongPress(item)} />
              )}
            />
          </View>
        );
      })}
    </ScrollView>
  );
}

function BoardCard({ task, onPress, onLongPress }: { task: ProjectTask; onPress: () => void; onLongPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const overdue = isOverdue(task);
  const childCount = task.children?.length ?? 0;
  return (
    <Touchable haptic="none" onPress={onPress} onLongPress={onLongPress} pressedStyle={{ opacity: 0.75 }} style={styles.card}>
      <View style={styles.cardTitleRow}>
        {task.task_type === 'milestone' ? <Icon name="diamond" size={12} color={c.warning} /> : null}
        <Text numberOfLines={2} style={styles.cardTitle}>
          {task.title}
        </Text>
      </View>
      <View style={styles.cardMeta}>
        {task.priority !== 'normal' ? <Icon name="flag" size={11} color={priorityColor(task.priority, c)} /> : null}
        {childCount > 0 ? (
          <View style={styles.metaPair}>
            <Icon name="list" size={11} color={c.fgFaint} />
            <Text style={styles.metaText}>{childCount}</Text>
          </View>
        ) : null}
        {task.due_date ? (
          <View style={styles.metaPair}>
            <Icon name="calendar" size={11} color={overdue ? c.danger : c.fgFaint} />
            <Text style={[styles.metaText, overdue && { color: c.danger, fontWeight: weight.semibold }]}>
              {shortDate(task.due_date)}
            </Text>
          </View>
        ) : null}
        <View style={{ flex: 1 }} />
        {task.assignee_nickname ? (
          <Text numberOfLines={1} style={[styles.metaText, { maxWidth: 90 }]}>
            {task.assignee_nickname}
          </Text>
        ) : null}
      </View>
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  lanes: { paddingHorizontal: 16, gap: LANE_GAP, flexGrow: 1 },
  lane: { flex: 1 },
  laneHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.md,
    marginBottom: 8,
  },
  laneTitle: { fontSize: font.small, fontWeight: weight.semibold, flex: 1 },
  laneCount: { fontSize: font.caption, color: c.fgMuted, fontWeight: weight.medium },
  laneEmpty: {
    height: 72,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.hairline,
    borderStyle: 'dashed',
    opacity: 0.6,
  },
  card: {
    backgroundColor: c.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 11,
    gap: 8,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardTitle: { flex: 1, fontSize: font.label, color: c.fg, fontWeight: weight.medium, lineHeight: 19 },
  cardMeta: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  metaPair: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaText: { fontSize: font.caption, color: c.fgFaint },
}));
