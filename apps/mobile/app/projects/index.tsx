/**
 * Projects — the hub page: collapsing large title, native search bar
 * (server-side search, debounced), an inset-grouped list of projects
 * (src/projects/project-row) and the cross-project global gantt.
 *
 * Navigation bar (all system): `+` creates a project (form sheet); the `…`
 * menu switches 列表 / 甘特图 and filters by status / priority (submenus with
 * checkmarks; the icon turns into the filled filter glyph while a filter is
 * on). Long-press a project for its context menu: 打开 / 预览 (peek sheet) /
 * 编辑 / 成员 / 删除 — edit and delete only for its owner, creator or a super
 * user (the server re-checks). Refetches on focus, so sheets that saved show
 * up on return. Loads are sequence-guarded (a late response for an older
 * query never overwrites newer results); a failed load shows a retry state,
 * never a fake "no projects". The global gantt sits behind the bottom search
 * field, so it gets a bottom inset.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Platform, RefreshControl, Text, View } from 'react-native';
import { Stack, useFocusEffect, useRouter } from 'expo-router';
import { useHeaderInset } from '../../src/ui/header-inset';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deleteProject,
  getGlobalGantt,
  listProjects,
  type GanttProject,
  type Priority,
  type Project,
  type ProjectStatus,
} from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { useAuth } from '../../src/store/auth';
import { GanttChart, type GanttSection } from '../../src/projects/gantt';
import { PRIORITIES, PROJECT_STATUSES, priorityLabel, projectAccess, projectStatusLabel } from '../../src/projects/meta';
import { ProjectRow } from '../../src/projects/project-row';
import { useProjects } from '../../src/projects/store';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { NativeButton } from '../../src/ui/button';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { menuSections, type MenuItem } from '../../src/ui/menu';
import { toast } from '../../src/ui/toast';
import { toolbarIcon } from '../../src/ui/toolbar-icon';

type ViewMode = 'list' | 'gantt';

/** Height of the iOS 26 bottom search field the gantt scrolls behind. */
const BOTTOM_SEARCH_H = 56;

export default function ProjectsScreen() {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const me = useAuth((s) => s.user);
  const forget = useProjects((s) => s.forget);
  const headerHeight = useHeaderInset();
  const insets = useSafeAreaInsets();

  const [view, setView] = useState<ViewMode>('list');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [gantt, setGantt] = useState<GanttProject[] | null>(null);
  const [ganttFailed, setGanttFailed] = useState(false);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filtered = status !== null || priority !== null;
  // Drops responses that arrive after a newer request was issued.
  const listSeq = useRef(0);
  const ganttSeq = useRef(0);

  const load = useCallback(
    async (q: string = query) => {
      const mine = ++listSeq.current;
      const data = await listProjects({
        search: q.trim() || undefined,
        status: status ?? undefined,
        priority: priority ?? undefined,
        limit: 100,
      });
      if (mine !== listSeq.current) return;
      if (data) setProjects(data.projects);
      else setProjects((prev) => prev ?? []);
      setListFailed(!data);
    },
    [query, status, priority],
  );

  const loadGantt = useCallback(async () => {
    const mine = ++ganttSeq.current;
    const data = await getGlobalGantt();
    if (mine !== ganttSeq.current) return;
    if (data) setGantt(data);
    else setGantt((prev) => prev ?? []);
    setGanttFailed(!data);
  }, []);

  // Refetch on focus (sheets that saved show up on return) and when a filter
  // changes. The refs keep the latest search text / view without re-running
  // the focus effect on every keystroke.
  const loadRef = useRef(load);
  loadRef.current = load;
  const viewRef = useRef(view);
  viewRef.current = view;
  useFocusEffect(
    useCallback(() => {
      void loadRef.current();
      if (viewRef.current === 'gantt') void loadGantt();
    }, [loadGantt]),
  );
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) void loadRef.current();
    mounted.current = true;
  }, [status, priority]);
  useEffect(() => {
    if (view === 'gantt') void loadGantt();
  }, [view, loadGantt]);

  useEffect(() => () => {
    if (debounce.current) clearTimeout(debounce.current);
  }, []);

  const onSearch = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => void load(text), 250);
    },
    [load],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await (view === 'gantt' ? loadGantt() : load());
    setRefreshing(false);
  }, [view, load, loadGantt]);

  const openProject = useCallback(
    (id: number) => router.push({ pathname: '/projects/[id]', params: { id: String(id) } }),
    [router],
  );

  const newProject = useCallback(() => router.push('/projects/project-form'), [router]);

  const removeProject = useCallback(
    async (p: Project) => {
      const yes = await confirmAction({
        title: t('projects.deleteProject'),
        message: t('projects.deleteProjectConfirm', { name: p.title }),
        confirmLabel: t('common.delete'),
        destructive: true,
      });
      if (!yes) return;
      if (!(await deleteProject(p.id))) {
        alertError(t('projects.deleteFailed'));
        return;
      }
      forget(p.id);
      setProjects((prev) => prev?.filter((x) => x.id !== p.id) ?? prev);
      setGantt((prev) => prev?.filter((x) => x.id !== p.id) ?? prev);
      toast(t('projects.projectDeleted'), 'trash');
    },
    [t, forget],
  );

  const rowMenu = useCallback(
    (p: Project): MenuItem[] => {
      const { canManage } = projectAccess(p, undefined, me);
      return menuSections([
        [
          { id: 'open', title: t('common.open'), icon: 'open' },
          { id: 'peek', title: t('projects.preview'), icon: 'eye' },
        ],
        [
          ...(canManage ? [{ id: 'edit', title: t('projects.editProject'), icon: 'pen' as const }] : []),
          { id: 'members', title: t('projects.members'), icon: 'users' },
        ],
        canManage ? [{ id: 'delete', title: t('projects.deleteProject'), icon: 'trash', destructive: true }] : [],
      ]);
    },
    [me, t],
  );

  const onRowMenu = useCallback(
    (p: Project, id: string) => {
      const pid = String(p.id);
      if (id === 'open') openProject(p.id);
      else if (id === 'peek') router.push({ pathname: '/peek/project/[id]', params: { id: pid } });
      else if (id === 'edit') router.push({ pathname: '/projects/project-form', params: { id: pid } });
      else if (id === 'members') router.push({ pathname: '/projects/members', params: { id: pid } });
      else if (id === 'delete') void removeProject(p);
    },
    [openProject, router, removeProject],
  );

  // Global gantt honours the same search + filters, client-side.
  const ganttSections = useMemo<GanttSection[]>(() => {
    const q = query.trim().toLowerCase();
    return (gantt ?? [])
      .filter((p) => (!status || p.status === status) && (!priority || p.priority === priority))
      .filter((p) => !q || p.title.toLowerCase().includes(q))
      .map((p) => ({
        project: { id: p.id, title: p.title, color: p.color, start_date: p.start_date, end_date: p.end_date, progress: p.progress },
        tasks: p.tasks,
      }));
  }, [gantt, query, status, priority]);

  const searching = query.trim().length > 0 || filtered;

  return (
    <>
      <Stack.Screen options={{ title: t('projects.title'), headerLargeTitleEnabled: view === 'list' }} />
      <Stack.SearchBar
        placeholder={t('projects.searchPlaceholder')}
        onChangeText={(e) => onSearch(e.nativeEvent.text)}
        onCancelButtonPress={() => onSearch('')}
        tintColor={hex.accent}
        autoCapitalize="none"
      />
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          // Android: its search action always sits last in the bar, so ⋮ wouldn't be — a filter glyph reads right in the middle
          icon={toolbarIcon(filtered ? 'filterOn' : Platform.OS === 'android' ? 'filter' : 'more')}
          accessibilityLabel={t('projects.viewOptions')}
        >
          <Stack.Toolbar.Menu inline>
            <Stack.Toolbar.MenuAction icon={toolbarIcon('list')} isOn={view === 'list'} onPress={() => setView('list')}>
              {t('projects.view_list')}
            </Stack.Toolbar.MenuAction>
            <Stack.Toolbar.MenuAction icon={toolbarIcon('gantt')} isOn={view === 'gantt'} onPress={() => setView('gantt')}>
              {t('projects.view_gantt')}
            </Stack.Toolbar.MenuAction>
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu title={t('projects.status')} icon={toolbarIcon('statusProgress')}>
            <Stack.Toolbar.MenuAction isOn={status === null} onPress={() => setStatus(null)}>
              {t('projects.all')}
            </Stack.Toolbar.MenuAction>
            {PROJECT_STATUSES.map((s) => (
              <Stack.Toolbar.MenuAction key={s} isOn={status === s} onPress={() => setStatus(s)}>
                {projectStatusLabel(s, t)}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.Menu title={t('projects.priority')} icon={toolbarIcon('flag')}>
            <Stack.Toolbar.MenuAction isOn={priority === null} onPress={() => setPriority(null)}>
              {t('projects.all')}
            </Stack.Toolbar.MenuAction>
            {PRIORITIES.map((p) => (
              <Stack.Toolbar.MenuAction key={p} isOn={priority === p} onPress={() => setPriority(p)}>
                {priorityLabel(p, t)}
              </Stack.Toolbar.MenuAction>
            ))}
          </Stack.Toolbar.Menu>
          <Stack.Toolbar.MenuAction
            icon={toolbarIcon('statusCancelled')}
            hidden={!filtered}
            onPress={() => {
              setStatus(null);
              setPriority(null);
            }}
          >
            {t('projects.clearFilters')}
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
        <Stack.Toolbar.Button icon={toolbarIcon('plus')} onPress={newProject} accessibilityLabel={t('projects.newProject')} />
      </Stack.Toolbar>

      {view === 'gantt' ? (
        <View style={[styles.root, { paddingTop: headerHeight + space.sm }]}>
          {gantt === null ? (
            <LoadingState />
          ) : ganttFailed && gantt.length === 0 ? (
            <EmptyState icon="alert" title={t('projects.loadFailed')} message={t('projects.loadFailedHint')} onRetry={() => void loadGantt()} />
          ) : ganttSections.length === 0 ? (
            <EmptyState icon={searching ? 'search' : 'gantt'} title={searching ? t('projects.emptySearch') : t('projects.empty')} />
          ) : (
            <GanttChart
              sections={ganttSections}
              bottomInset={insets.bottom + BOTTOM_SEARCH_H}
              onOpenProject={openProject}
              onOpenTask={(task) =>
                router.push({
                  pathname: '/projects/task/[taskId]',
                  params: { taskId: String(task.id), projectId: String(task.project_id) },
                })
              }
            />
          )}
        </View>
      ) : (
        <FlatList
          style={styles.root}
          data={projects ?? []}
          keyExtractor={(p) => String(p.id)}
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void onRefresh()} tintColor={hex.accent} />}
          ListHeaderComponent={
            filtered ? (
              <View style={styles.filterBar}>
                <Text style={styles.filterText} numberOfLines={1}>
                  {[status && projectStatusLabel(status, t), priority && priorityLabel(priority, t)].filter(Boolean).join(' · ')}
                </Text>
                <NativeButton
                  label={t('projects.clearFilters')}
                  size="small"
                  onPress={() => {
                    setStatus(null);
                    setPriority(null);
                  }}
                />
              </View>
            ) : null
          }
          ListEmptyComponent={
            projects === null ? (
              <LoadingState />
            ) : listFailed ? (
              <EmptyState icon="alert" title={t('projects.loadFailed')} message={t('projects.loadFailedHint')} onRetry={() => void load()} />
            ) : searching ? (
              <EmptyState icon="search" title={t('projects.emptySearch')} />
            ) : (
              <EmptyState
                icon="folder"
                title={t('projects.empty')}
                message={t('projects.emptyHint')}
                action={<NativeButton label={t('projects.newProject')} icon="plus" variant="prominent" onPress={newProject} />}
              />
            )
          }
          renderItem={({ item, index }) => (
            <ProjectRow
              project={item}
              first={index === 0}
              last={index === (projects?.length ?? 0) - 1}
              onPress={() => openProject(item.id)}
              menu={rowMenu(item)}
              onMenu={(id) => onRowMenu(item, id)}
            />
          )}
        />
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.groupedBackground },
  listContent: { paddingTop: space.sm, paddingBottom: space.xxxl, flexGrow: 1 },
  filterBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: space.margin * 2,
    paddingBottom: space.sm,
  },
  filterText: { ...typo.footnote, color: c.secondaryLabel, flex: 1, textTransform: 'uppercase' },
}));
