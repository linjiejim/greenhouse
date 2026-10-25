/**
 * 项目 — the project list and my tasks (open tasks assigned to me across projects, grouped by
 * when they are due: src/data/tasks.ts `myTasks`, from the gantt view; kept on the phone and
 * shown offline, src/data/use-offline-resource.ts). A project opens as a large sheet and its
 * tasks stack on it; a task opens as a sheet straight away. A member without the Projects
 * capability gets a 403: say so instead of an error with a retry.
 */

import React, { useCallback, useMemo } from 'react';
import { FlatList, Text, View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { createProject, gantt, listProjects } from '../../../src/api/projects';
import type { ApiResult } from '../../../src/api/client';
import { captureIdentity } from '../../../src/data/identity';
import { noAccess } from '../../../src/data/access';
import { groupMyTasks, localDay, myTasks, type DueBucket, type MyTask } from '../../../src/data/tasks';
import { parseMyTasks } from '../../../src/data/recent-items';
import { useOfflineResource } from '../../../src/data/use-offline-resource';
import { useResource } from '../../../src/data/use-resource';
import { useT } from '../../../src/lib/i18n';
import { calendarDateLabel } from '../../../src/lib/time-words';
import { statusIcon, statusTint } from '../../../src/projects/look';
import type { Project } from '../../../src/shared/greenhouse-types';
import { useAuth } from '../../../src/store/auth';
import { makeStyles, space, typo, useTheme } from '../../../src/theme';
import { NativeButton } from '../../../src/ui/button';
import { alertError, promptText } from '../../../src/ui/dialogs';
import { DirectorySearch, useDirectoryFilter } from '../../../src/ui/directory-search';
import { SidebarToolbar } from '../../../src/ui/sidebar';
import { EmptyState, LoadingState } from '../../../src/ui/empty';
import { notifySuccess } from '../../../src/ui/haptics';
import { refreshItem, usePullRefresh } from '../../../src/ui/refresh';
import { toolbarIcon } from '../../../src/ui/toolbar-icon';
import { Row, SectionHeader, rowPosition, type RowPosition } from '../../../src/ui/list';
import { Segmented } from '../../../src/ui/segmented';
import { useOpenObject } from '../../../src/shell/open-object';

type Tab = 'all' | 'mine';
type Item =
  | { key: string; type: 'header'; title: string }
  | { key: string; type: 'task'; task: MyTask; bucket: DueBucket; position: RowPosition }
  | { key: string; type: 'project'; project: Project; position: RowPosition };

export default function Projects() {
  const params = useLocalSearchParams<{ tab?: string }>();
  const tab: Tab = params.tab === 'mine' ? 'mine' : 'all';
  const t = useT();
  const router = useRouter();
  const openObject = useOpenObject();
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const userId = useAuth((s) => s.user?.id);

  const loadMine = useCallback(async (): Promise<ApiResult<ReturnType<typeof myTasks>>> => {
    const result = await gantt();
    if (!result.ok) return result;
    return { ok: true, data: myTasks(result.data.projects, userId ?? '', localDay(new Date())) };
  }, [userId]);
  const loadAll = useCallback(() => listProjects(captureIdentity()), []);
  // my tasks read offline too: the last list the station gave stays on this phone
  const mine = useOfflineResource('my-tasks', loadMine, parseMyTasks);
  const all = useResource(loadAll);
  const resource = tab === 'mine' ? mine : all;
  const pull = usePullRefresh(resource.refresh);
  const busy = resource.loading && !!resource.data && !pull.refreshing;
  const filter = useDirectoryFilter();
  const query = filter.query.trim().toLowerCase();
  const matches = useCallback(
    (...words: (string | null | undefined)[]) => !query || words.some((w) => w?.toLowerCase().includes(query)),
    [query],
  );

  const newProject = async () => {
    const title = (
      await promptText({ title: t('projects.newProject'), placeholder: t('projects.newProjectName') })
    )?.trim();
    if (!title) return;
    const current = captureIdentity();
    const made = await createProject(title.slice(0, 200));
    if (!current()) return;
    if (!made.ok) {
      alertError(t('projects.createFailed'), made.message || undefined);
      return;
    }
    notifySuccess();
    void all.refresh();
    openObject({ kind: 'project', id: made.data.project.id });
  };

  const rows = useMemo((): Item[] => {
    if (tab === 'mine') {
      const out: Item[] = [];
      // grouped again for today: a saved copy keeps the groups of the day it was saved
      const groups = groupMyTasks((mine.data ?? []).flatMap((group) => group.tasks), localDay(new Date()));
      for (const whole of groups) {
        const group = { ...whole, tasks: whole.tasks.filter((task) => matches(task.title, task.project_title)) };
        if (!group.tasks.length) continue;
        out.push({ key: `h-${group.bucket}`, type: 'header', title: t(`projects.dueGroup.${group.bucket}`) });
        group.tasks.forEach((task, i) =>
          out.push({ key: `t-${task.id}`, type: 'task', task, bucket: group.bucket, position: rowPosition(i, group.tasks.length) }),
        );
      }
      return out;
    }
    const projects = (all.data ?? []).filter((p) => p.status !== 'archived' && matches(p.title));
    return projects.map((project, i) => ({ key: `p-${project.id}`, type: 'project', project, position: rowPosition(i, projects.length) }));
  }, [tab, mine.data, all.data, matches, t]);

  const header = (
    <View>
      <Segmented
        value={tab}
        onChange={(value) => router.setParams({ tab: value })}
        options={(['all', 'mine'] as const).map((value) => ({ value, label: t(`projects.tabs.${value}`) }))}
        style={styles.segmented}
      />
      {tab === 'mine' && mine.offline ? <Text style={styles.offline}>{t('common.savedCopy')}</Text> : null}
    </View>
  );

  const empty = query ? (
    <EmptyState icon="search" title={t('common.noMatches')} style={styles.state} />
  ) : !resource.data ? (
    resource.loading ? (
      <LoadingState style={styles.state} />
    ) : noAccess(resource.error) ? (
      <EmptyState icon="hand" title={t('projects.noAccess')} message={t('projects.noAccessHint')} style={styles.state} />
    ) : (
      <EmptyState icon="alert" title={t('projects.loadFailed')} onRetry={() => void resource.refresh()} style={styles.state} />
    )
  ) : tab === 'mine' ? (
    <EmptyState icon="checkCircle" title={t('projects.noTasks')} message={t('projects.noTasksHint')} style={styles.state} />
  ) : (
    <EmptyState
      icon="checkCircle"
      title={t('projects.empty')}
      message={t('projects.emptyHint')}
      action={
        <NativeButton
          label={t('projects.newProject')}
          icon="plus"
          variant="prominent"
          onPress={() => void newProject()}
        />
      }
      style={styles.state}
    />
  );

  return (
    <>
      <Stack.Screen options={{ title: t('nav.projects') }} />
      <DirectorySearch filter={filter} />
      <SidebarToolbar />
      <Stack.Toolbar placement="right">
        {refreshItem(busy, t('common.loading'))}
        <Stack.Toolbar.Button
          icon={toolbarIcon('plus')}
          accessibilityLabel={t('projects.newProject')}
          onPress={() => void newProject()}
        />
      </Stack.Toolbar>
      <FlatList<Item>
        style={styles.root}
        contentInsetAdjustmentBehavior="automatic"
        data={rows}
        keyExtractor={(row) => row.key}
        ListHeaderComponent={header}
        refreshing={pull.refreshing}
        onRefresh={pull.onRefresh}
        renderItem={({ item }) => {
          if (item.type === 'header') return <SectionHeader title={item.title} />;
          if (item.type === 'task') {
            const { task } = item;
            const due = task.due_date ? calendarDateLabel(task.due_date.slice(0, 10)) : '';
            return (
              <Row
                title={task.title}
                subtitle={[due, task.project_title].filter(Boolean).join(' · ')}
                titleLines={2}
                icon={statusIcon(task.status)}
                iconTint={statusTint(task.status, c)}
                accessibilityLabel={[task.title, t(`projects.status.${task.status}`), due, task.project_title].filter(Boolean).join(', ')}
                accessory="chevron"
                position={item.position}
                onPress={() => openObject({ kind: 'task', projectId: task.project_id, id: task.id })}
              />
            );
          }
          const { project } = item;
          const stats = project.stats;
          return (
            <Row
              title={project.title}
              subtitle={[
                t(`projects.projectStatus.${project.status}`),
                stats ? t('projects.taskCount', { n: stats.total }) : '',
                project.progress != null ? t('projects.progress', { n: project.progress }) : '',
              ]
                .filter(Boolean)
                .join(' · ')}
              icon="checkCircle"
              iconTint={project.color ?? undefined}
              accessory="chevron"
              position={item.position}
              onPress={() => openObject({ kind: 'project', id: project.id })}
            />
          );
        }}
        ListEmptyComponent={empty}
        contentContainerStyle={styles.content}
      />
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  content: { paddingBottom: space.xxxl },
  segmented: { marginHorizontal: space.margin, marginVertical: space.md },
  state: { paddingTop: space.xxxl },
  offline: { ...typo.footnote, color: c.secondaryLabel, marginHorizontal: space.margin + space.xs, marginBottom: space.sm },
}));
