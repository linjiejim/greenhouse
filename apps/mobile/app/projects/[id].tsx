/**
 * Project detail — compact header (progress subtitle, members + ⋯ menu), a
 * 列表/看板/甘特 segmented switch, task long-press actions and a "+" FAB.
 * Web parity: pages/project-detail.tsx with drag interactions replaced by
 * sheets (see gantt.tsx header note).
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  listAssignableUsers,
  type AssignableUser,
  type ProjectDetail,
  type ProjectTask,
  deleteProject,
  getProject,
} from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { BoardView } from '../../src/projects/board';
import { GanttChart } from '../../src/projects/gantt';
import { projectStatusLabel } from '../../src/projects/meta';
import { ProjectFormSheet } from '../../src/projects/project-form-sheet';
import { ActivitiesSheet, MembersSheet } from '../../src/projects/project-sheets';
import { TaskActionsHost } from '../../src/projects/task-action-sheets';
import { TaskFormSheet } from '../../src/projects/task-form-sheet';
import { TaskTreeList } from '../../src/projects/task-list';
import { ActionSheet, Icon, ScreenHeader, Skeleton, Touchable } from '../../src/ui';
import { font, makeStyles, radius, shadow, useTheme, weight } from '../../src/theme';

type ViewMode = 'list' | 'board' | 'gantt';

export default function ProjectDetailScreen() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; title?: string }>();
  const projectId = Number(params.id);

  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [view, setView] = useState<ViewMode>('list');
  const [refreshing, setRefreshing] = useState(false);

  const [menuOpen, setMenuOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  const [activitiesOpen, setActivitiesOpen] = useState(false);
  const [projectFormOpen, setProjectFormOpen] = useState(false);

  const [taskFormOpen, setTaskFormOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<ProjectTask | null>(null);
  const [subtaskParent, setSubtaskParent] = useState<number | undefined>(undefined);
  const [milestoneMode, setMilestoneMode] = useState(false);
  const [actionTask, setActionTask] = useState<ProjectTask | null>(null);

  const load = useCallback(async () => {
    if (!Number.isFinite(projectId)) return;
    const data = await getProject(projectId);
    setDetail(data);
  }, [projectId]);

  // Reload whenever the screen regains focus (task page edits, first mount).
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useEffect(() => {
    void listAssignableUsers().then(setUsers);
  }, []);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const openTask = useCallback(
    (task: ProjectTask) => {
      router.push({
        pathname: '/projects/task/[taskId]',
        params: { taskId: String(task.id), projectId: String(projectId), title: task.title },
      });
    },
    [router, projectId],
  );

  const openCreateTask = useCallback((parentId?: number, milestone = false) => {
    setEditingTask(null);
    setSubtaskParent(parentId);
    setMilestoneMode(milestone);
    setTaskFormOpen(true);
  }, []);

  const openEditTask = useCallback((task: ProjectTask) => {
    setEditingTask(task);
    setSubtaskParent(undefined);
    setMilestoneMode(false);
    setTaskFormOpen(true);
  }, []);

  const confirmDeleteProject = useCallback(() => {
    if (!detail) return;
    Alert.alert(t('projects.deleteProject'), t('projects.deleteProjectConfirm', { name: detail.project.title }), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'),
        style: 'destructive',
        onPress: () =>
          void deleteProject(projectId).then(() => {
            router.back();
          }),
      },
    ]);
  }, [detail, projectId, router, t]);

  const subtitle = useMemo(() => {
    if (!detail) return undefined;
    const parts = [projectStatusLabel(detail.project.status, t)];
    if (detail.stats.total > 0) parts.push(`${detail.progress}% · ${t('projects.taskCount', { done: detail.stats.done, total: detail.stats.total })}`);
    return parts.join(' · ');
  }, [detail, t]);

  const title = detail?.project.title ?? params.title ?? t('projects.title');

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <ScreenHeader
        variant="compact"
        align="left"
        title={title}
        subtitle={subtitle}
        onLeading={() => router.back()}
        right={
          <View style={{ flexDirection: 'row' }}>
            <Touchable haptic="none" onPress={() => setMembersOpen(true)} style={styles.headerBtn} accessibilityLabel={t('projects.members')}>
              <Icon name="users" size={20} color={c.fg} />
              {detail && detail.members.length > 0 ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{detail.members.length}</Text>
                </View>
              ) : null}
            </Touchable>
            <Touchable haptic="none" onPress={() => setMenuOpen(true)} style={styles.headerBtn} accessibilityLabel="menu">
              <Icon name="more" size={20} color={c.fg} />
            </Touchable>
          </View>
        }
      />

      <View style={{ paddingHorizontal: 16, paddingBottom: 10 }}>
        <SegmentedViews value={view} onChange={setView} />
      </View>

      {detail === null ? (
        <View style={{ paddingHorizontal: 16, gap: 10 }}>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} style={{ height: 44, borderRadius: radius.md }} />
          ))}
        </View>
      ) : view === 'list' ? (
        <TaskTreeList
          tasks={detail.tasks}
          onOpen={openTask}
          onLongPress={setActionTask}
          refreshing={refreshing}
          onRefresh={() => void onRefresh()}
        />
      ) : view === 'board' ? (
        <BoardView tasks={detail.tasks} onOpen={openTask} onLongPress={setActionTask} />
      ) : (
        <GanttChart sections={[{ tasks: detail.tasks }]} onOpenTask={openTask} onLongPressTask={setActionTask} />
      )}

      {/* new-task FAB */}
      <Touchable
        haptic="light"
        accessibilityLabel={t('projects.newTask')}
        onPress={() => openCreateTask()}
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
      >
        <Icon name="plus" size={26} color={c.onAccent} sw={2.2} />
      </Touchable>

      {/* header ⋯ menu */}
      <ActionSheet
        visible={menuOpen}
        onClose={() => setMenuOpen(false)}
        items={[
          { id: 'edit', label: t('projects.editProject'), icon: 'pen' },
          { id: 'milestone', label: t('projects.newMilestone'), icon: 'diamond' },
          { id: 'activities', label: t('projects.activities'), icon: 'activity' },
          { id: 'delete', label: t('projects.deleteProject'), icon: 'trash', danger: true },
        ]}
        onPick={(id) => {
          if (id === 'edit') setProjectFormOpen(true);
          else if (id === 'milestone') openCreateTask(undefined, true);
          else if (id === 'activities') setActivitiesOpen(true);
          else if (id === 'delete') confirmDeleteProject();
        }}
      />

      <TaskActionsHost
        task={actionTask}
        onClose={() => setActionTask(null)}
        onChanged={() => void load()}
        onView={openTask}
        onEdit={openEditTask}
        onAddSubtask={(task) => openCreateTask(task.id)}
      />

      <TaskFormSheet
        visible={taskFormOpen}
        onClose={() => setTaskFormOpen(false)}
        projectId={projectId}
        task={editingTask}
        parentId={subtaskParent}
        milestone={milestoneMode}
        users={users}
        onSaved={() => void load()}
      />

      <ProjectFormSheet
        visible={projectFormOpen}
        onClose={() => setProjectFormOpen(false)}
        project={detail?.project ?? null}
        users={users}
        onSaved={() => void load()}
      />

      {detail ? (
        <MembersSheet
          visible={membersOpen}
          onClose={() => setMembersOpen(false)}
          projectId={projectId}
          members={detail.members}
          users={users}
          onChanged={() => void load()}
        />
      ) : null}

      <ActivitiesSheet visible={activitiesOpen} onClose={() => setActivitiesOpen(false)} projectId={projectId} />
    </View>
  );
}

function SegmentedViews({ value, onChange }: { value: ViewMode; onChange: (v: ViewMode) => void }) {
  const t = useT();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const items: Array<{ id: ViewMode; icon: 'list' | 'board' | 'gantt'; label: string }> = [
    { id: 'list', icon: 'list', label: t('projects.view_list') },
    { id: 'board', icon: 'board', label: t('projects.view_board') },
    { id: 'gantt', icon: 'gantt', label: t('projects.view_gantt') },
  ];
  return (
    <View style={styles.segWrap}>
      {items.map((it) => {
        const on = it.id === value;
        return (
          <Touchable key={it.id} haptic="selection" onPress={() => onChange(it.id)} style={[styles.segItem, on && styles.segItemOn]}>
            <Icon name={it.icon} size={15} color={on ? c.accentDeep : c.fgMuted} />
            <Text style={[styles.segText, on && { color: c.accentDeep, fontWeight: weight.semibold }]}>{it.label}</Text>
          </Touchable>
        );
      })}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  headerBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  badge: {
    position: 'absolute',
    top: 3,
    right: 1,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    paddingHorizontal: 3,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 9, fontWeight: weight.bold, color: c.onAccent },

  segWrap: { flexDirection: 'row', backgroundColor: c.surfaceMuted, borderRadius: radius.md, padding: 3, gap: 2 },
  segItem: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingVertical: 7,
    borderRadius: 7,
  },
  segItemOn: { backgroundColor: c.surface, ...shadow.card },
  segText: { fontSize: font.small, color: c.fgMuted, fontWeight: weight.medium },

  fab: {
    position: 'absolute',
    right: 20,
    width: 54,
    height: 54,
    borderRadius: 27,
    backgroundColor: c.accent,
    alignItems: 'center',
    justifyContent: 'center',
    ...shadow.accent,
  },
}));
