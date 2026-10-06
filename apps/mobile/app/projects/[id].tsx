/**
 * Project detail — inline title (the project name), a status / progress
 * summary line and a native segmented control switching 列表 / 看板 / 甘特
 * (src/projects/{task-list,board,gantt}). Web parity: pages/project-detail.tsx
 * with drag interactions replaced by context menus and form sheets.
 *
 * Navigation bar: `+` new task (form sheet); the `…` menu holds 编辑项目 /
 * 新建里程碑 / 成员 / 动态 / 删除项目. Write actions follow the server's rules
 * (members write, owners / creators / super manage — src/projects/meta
 * `projectAccess`) and are hidden otherwise; with write access each board
 * lane also has a `+` (new task preset to that status). The detail comes from
 * the shared projects store and is refetched on focus, so sheets that saved
 * are reflected on return; after a transient (offline) failure the last copy
 * stays on screen, a definitive 403/404 shows the "not available" state.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useHeaderHeight } from 'expo-router/react-navigation';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { deleteProject, type TaskStatus } from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { useAuth } from '../../src/store/auth';
import { BoardView } from '../../src/projects/board';
import { GanttChart, type GanttSection } from '../../src/projects/gantt';
import { projectAccess, projectColor, projectStatusColor, projectStatusLabel } from '../../src/projects/meta';
import { ProgressBar } from '../../src/projects/progress';
import { useProjectDetail, useProjects } from '../../src/projects/store';
import { useTaskActions } from '../../src/projects/task-actions';
import { TaskTreeList } from '../../src/projects/task-list';
import { makeStyles, space, typo, useTheme, weight } from '../../src/theme';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { Segmented } from '../../src/ui/segmented';
import { toast } from '../../src/ui/toast';

type ViewMode = 'list' | 'board' | 'gantt';

export default function ProjectDetailScreen() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const headerHeight = useHeaderHeight();
  const insets = useSafeAreaInsets();
  const me = useAuth((s) => s.user);
  const forget = useProjects((s) => s.forget);
  const params = useLocalSearchParams<{ id: string }>();
  const projectId = Number(params.id);
  const pid = String(projectId);

  const { detail, failed, reload } = useProjectDetail(projectId, { refetchOnFocus: true });
  const actions = useTaskActions(projectId);
  const [view, setView] = useState<ViewMode>('list');
  const [refreshing, setRefreshing] = useState(false);

  const access = detail ? projectAccess(detail.project, detail.members, me) : { canWrite: false, canManage: false };

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }, [reload]);

  const removeProject = useCallback(async () => {
    if (!detail) return;
    const yes = await confirmAction({
      title: t('projects.deleteProject'),
      message: t('projects.deleteProjectConfirm', { name: detail.project.title }),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (!yes) return;
    if (!(await deleteProject(projectId))) {
      alertError(t('projects.deleteFailed'));
      return;
    }
    toast(t('projects.projectDeleted'), 'trash');
    router.back();
    forget(projectId);
  }, [detail, t, projectId, router, forget]);

  const newTask = useCallback(
    (opts: { milestone?: boolean; status?: TaskStatus } = {}) =>
      router.push({
        pathname: '/projects/task-form',
        params: {
          projectId: pid,
          ...(opts.milestone ? { milestone: '1' } : null),
          ...(opts.status ? { status: opts.status } : null),
        },
      }),
    [router, pid],
  );

  // Stable across re-renders so the gantt keeps its expand/collapse state.
  const tasks = detail?.tasks;
  const ganttSections = useMemo<GanttSection[]>(() => [{ tasks: tasks ?? [] }], [tasks]);

  const project = detail?.project;
  const color = projectColor(project?.color, hex);

  return (
    <>
      <Stack.Screen options={{ title: project?.title ?? '' }} />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu icon="ellipsis" accessibilityLabel={t('common.more')} hidden={!detail}>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction
              icon="pencil"
              hidden={!access.canWrite}
              onPress={() => router.push({ pathname: '/projects/project-form', params: { id: pid } })}
            >
              {t('projects.editProject')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon="diamond" hidden={!access.canWrite} onPress={() => newTask({ milestone: true })}>
              {t('projects.newMilestone')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction
              icon="person.2"
              subtitle={detail ? t('projects.memberCount', { n: detail.members.length }) : undefined}
              onPress={() => router.push({ pathname: '/projects/members', params: { id: pid } })}
            >
              {t('projects.members')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction
              icon="clock.arrow.circlepath"
              onPress={() => router.push({ pathname: '/projects/activity', params: { id: pid } })}
            >
              {t('projects.activities')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.MenuAction icon="trash" destructive hidden={!access.canManage} onPress={() => void removeProject()}>
            {t('projects.deleteProject')}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button
          icon="plus"
          hidden={!access.canWrite}
          onPress={() => newTask()}
          accessibilityLabel={t('projects.newTask')}
        />
      </Stack.Toolbar>

      {!detail ? (
        failed ? (
          <ScrollView
            contentInsetAdjustmentBehavior="automatic"
            contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}
            refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={hex.accent} />}
          >
            <EmptyState
              icon="alert"
              title={t('projects.projectMissing')}
              message={t('projects.projectMissingHint')}
              onRetry={() => void reload()}
            />
          </ScrollView>
        ) : (
          <LoadingState style={{ paddingTop: headerHeight }} />
        )
      ) : (
        <View style={[styles.root, { paddingTop: headerHeight }]}>
          <View style={styles.top}>
            <View style={styles.summary}>
              <Text style={[styles.summaryStatus, { color: projectStatusColor(detail.project.status, c) }]}>
                {projectStatusLabel(detail.project.status, t)}
              </Text>
              <Text style={styles.summaryText}>
                {detail.stats.total > 0
                  ? t('projects.taskCount', { done: detail.stats.done, total: detail.stats.total })
                  : t('projects.noTasks')}
              </Text>
              <View style={styles.summaryBar}>
                <ProgressBar pct={detail.progress} color={color} height={5} />
              </View>
              <Text style={styles.summaryPct}>{detail.progress}%</Text>
            </View>
            <Segmented<ViewMode>
              value={view}
              onChange={setView}
              options={[
                { value: 'list', label: t('projects.view_list') },
                { value: 'board', label: t('projects.view_board') },
                { value: 'gantt', label: t('projects.view_gantt') },
              ]}
            />
          </View>

          {view === 'list' ? (
            <TaskTreeList
              tasks={detail.tasks}
              actions={actions}
              canWrite={access.canWrite}
              refreshing={refreshing}
              onRefresh={() => void onRefresh()}
            />
          ) : view === 'board' ? (
            <BoardView
              tasks={detail.tasks}
              actions={actions}
              canWrite={access.canWrite}
              onAdd={(status) => newTask({ status })}
              bottomInset={insets.bottom}
            />
          ) : (
            <GanttChart
              sections={ganttSections}
              bottomInset={insets.bottom + space.sm}
              onOpenTask={actions.open}
              taskMenu={access.canWrite ? { items: (task) => actions.menuItems(task), onSelect: actions.onSelect } : undefined}
            />
          )}
        </View>
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1 },
  top: { paddingHorizontal: space.margin, paddingTop: space.xs, paddingBottom: space.md, gap: space.md },
  summary: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  summaryStatus: { ...typo.subheadline, fontWeight: weight.semibold },
  summaryText: { ...typo.subheadline, color: c.secondaryLabel },
  summaryBar: { flex: 1, marginHorizontal: space.xs },
  summaryPct: { ...typo.footnote, fontWeight: weight.semibold, color: c.secondaryLabel, fontVariant: ['tabular-nums'] },
}));
