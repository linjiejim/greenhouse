/**
 * Projects list — searchable, status/priority chip filters, a 列表/甘特
 * segmented view (gantt = the cross-project global gantt fed by
 * GET /api/projects/gantt), a "+" FAB to create, long-press to edit/delete.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, ScrollView, Text, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  deleteProject,
  getGlobalGantt,
  listAssignableUsers,
  listProjects,
  type AssignableUser,
  type GanttProject,
  type Priority,
  type Project,
  type ProjectStatus,
} from '../../src/api/projects';
import { useT } from '../../src/lib/i18n';
import { GanttChart } from '../../src/projects/gantt';
import {
  PRIORITIES,
  PROJECT_STATUSES,
  hexAlpha,
  priorityColor,
  priorityLabel,
  projectStatusColor,
  projectStatusLabel,
  projectStatusTint,
  shortDate,
  type TranslateFn,
} from '../../src/projects/meta';
import { ProjectFormSheet } from '../../src/projects/project-form-sheet';
import { ActionSheet, EmptyState, Field, Icon, ProgressRing, ScreenHeader, Segmented, Skeleton, Touchable } from '../../src/ui';
import { font, makeStyles, radius, shadow, useTheme, weight, type ThemeColors } from '../../src/theme';

type ViewMode = 'list' | 'gantt';

export default function ProjectsScreen() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [view, setView] = useState<ViewMode>('list');
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [ganttProjects, setGanttProjects] = useState<GanttProject[] | null>(null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [priority, setPriority] = useState<Priority | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Project | null>(null);
  const [actionProject, setActionProject] = useState<Project | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(
    async (q?: string) => {
      const data = await listProjects({
        search: (q ?? search).trim() || undefined,
        status: status ?? undefined,
        priority: priority ?? undefined,
        limit: 100,
      });
      setProjects(data.projects);
    },
    [search, status, priority],
  );

  const loadGantt = useCallback(async () => {
    setGanttProjects(await getGlobalGantt());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void listAssignableUsers().then(setUsers);
  }, []);

  useEffect(() => {
    if (view === 'gantt' && ganttProjects === null) void loadGantt();
  }, [view, ganttProjects, loadGantt]);

  const onSearch = useCallback(
    (v: string) => {
      setSearch(v);
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => void load(v), 300);
    },
    [load],
  );

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await (view === 'gantt' ? loadGantt() : load());
    setRefreshing(false);
  }, [view, load, loadGantt]);

  const reloadAll = useCallback(() => {
    void load();
    setGanttProjects(null); // refetched lazily next time gantt is shown
  }, [load]);

  const openProject = useCallback(
    (p: { id: number; title: string }) => {
      router.push({ pathname: '/projects/[id]', params: { id: String(p.id), title: p.title } });
    },
    [router],
  );

  const confirmDelete = useCallback(
    (p: Project) => {
      Alert.alert(t('projects.deleteProject'), t('projects.deleteProjectConfirm', { name: p.title }), [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('common.delete'), style: 'destructive', onPress: () => void deleteProject(p.id).then(reloadAll) },
      ]);
    },
    [t, reloadAll],
  );

  const ganttSections = useMemo(
    () =>
      (ganttProjects ?? []).map((p) => ({
        project: { id: p.id, title: p.title, color: p.color, start_date: p.start_date, end_date: p.end_date, progress: p.progress },
        tasks: p.tasks,
      })),
    [ganttProjects],
  );

  return (
    <View style={[styles.root, { paddingTop: insets.top + 2 }]}>
      <ScreenHeader
        variant="large"
        title={t('projects.title')}
        onLeading={() => router.back()}
        right={
          <Segmented<ViewMode>
            style={{ width: 148 }}
            items={[
              { id: 'list', label: t('projects.view_list') },
              { id: 'gantt', label: t('projects.view_gantt') },
            ]}
            value={view}
            onChange={setView}
          />
        }
      />

      {view === 'list' ? (
        <>
          <View style={{ paddingHorizontal: 16, paddingBottom: 8 }}>
            <Field icon="search" placeholder={t('projects.searchPlaceholder')} value={search} onChangeText={onSearch} autoCapitalize="none" />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.filters}>
            <FilterChip label={t('projects.all')} active={status === null} onPress={() => setStatus(null)} />
            {PROJECT_STATUSES.map((s) => (
              <FilterChip
                key={s}
                label={projectStatusLabel(s, t)}
                active={status === s}
                color={projectStatusColor(s, c)}
                onPress={() => setStatus(status === s ? null : s)}
              />
            ))}
            <View style={styles.filterDivider} />
            {PRIORITIES.map((p) => (
              <FilterChip
                key={p}
                label={priorityLabel(p, t)}
                active={priority === p}
                color={priorityColor(p, c)}
                onPress={() => setPriority(priority === p ? null : p)}
              />
            ))}
          </ScrollView>

          {projects === null ? (
            <View style={{ paddingHorizontal: 16, gap: 10, paddingTop: 8 }}>
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} style={{ height: 104, borderRadius: radius.lg }} />
              ))}
            </View>
          ) : (
            <FlatList
              data={projects}
              keyExtractor={(p) => String(p.id)}
              contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: insets.bottom + 96, flexGrow: 1 }}
              refreshing={refreshing}
              onRefresh={onRefresh}
              showsVerticalScrollIndicator={false}
              ListEmptyComponent={
                <EmptyState
                  icon="folder"
                  title={search || status || priority ? t('projects.emptySearch') : t('projects.empty')}
                  sub={search || status || priority ? undefined : t('projects.emptyHint')}
                  cta={search || status || priority ? undefined : t('projects.newProject')}
                  onCta={() => {
                    setEditing(null);
                    setFormOpen(true);
                  }}
                />
              }
              renderItem={({ item }) => (
                <ProjectCard
                  project={item}
                  colors={c}
                  t={t}
                  onPress={() => openProject(item)}
                  onLongPress={() => setActionProject(item)}
                />
              )}
            />
          )}
        </>
      ) : ganttProjects === null ? (
        <View style={{ paddingHorizontal: 16, gap: 10, paddingTop: 8 }}>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} style={{ height: 40, borderRadius: radius.md }} />
          ))}
        </View>
      ) : (
        <GanttChart
          sections={ganttSections}
          onOpenProject={(id) => {
            const p = ganttProjects.find((x) => x.id === id);
            if (p) openProject(p);
          }}
          onOpenTask={(task) =>
            router.push({ pathname: '/projects/task/[taskId]', params: { taskId: String(task.id), projectId: String(task.project_id), title: task.title } })
          }
        />
      )}

      {/* create FAB */}
      <Touchable
        haptic="light"
        accessibilityLabel={t('projects.newProject')}
        onPress={() => {
          setEditing(null);
          setFormOpen(true);
        }}
        style={[styles.fab, { bottom: insets.bottom + 24 }]}
      >
        <Icon name="plus" size={26} color={c.onAccent} sw={2.2} />
      </Touchable>

      <ProjectFormSheet
        visible={formOpen}
        onClose={() => setFormOpen(false)}
        project={editing}
        users={users}
        onSaved={(id) => {
          reloadAll();
          if (!editing) router.push({ pathname: '/projects/[id]', params: { id: String(id) } });
        }}
      />

      <ActionSheet
        visible={!!actionProject}
        onClose={() => setActionProject(null)}
        items={[
          { id: 'edit', label: t('projects.editProject'), icon: 'pen' },
          { id: 'delete', label: t('projects.deleteProject'), icon: 'trash', danger: true },
        ]}
        onPick={(id) => {
          const p = actionProject;
          if (!p) return;
          if (id === 'edit') {
            setEditing(p);
            setFormOpen(true);
          } else if (id === 'delete') {
            confirmDelete(p);
          }
        }}
      />
    </View>
  );
}

// ─── Pieces ──────────────────────────────────────────────

function FilterChip({ label, active, color, onPress }: { label: string; active: boolean; color?: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const tone = color ?? c.accent;
  return (
    <Touchable
      haptic="selection"
      onPress={onPress}
      style={[styles.filterChip, active && { borderColor: tone, backgroundColor: hexAlpha(tone, 0.1) }]}
    >
      <Text style={[styles.filterChipText, active && { color: c.fg, fontWeight: weight.semibold }]}>{label}</Text>
    </Touchable>
  );
}

function ProjectCard({
  project,
  colors: c,
  t,
  onPress,
  onLongPress,
}: {
  project: Project;
  colors: ThemeColors;
  t: TranslateFn;
  onPress: () => void;
  onLongPress: () => void;
}) {
  const styles = useStyles(c);
  const stats = project.stats;
  const progress = project.progress ?? 0;
  return (
    <Touchable haptic="none" onPress={onPress} onLongPress={onLongPress} pressedStyle={{ opacity: 0.75 }} style={styles.card}>
      <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
        <View style={styles.cardTitleRow}>
          <View style={[styles.cardDot, { backgroundColor: project.color ?? c.accent }]} />
          <Text numberOfLines={1} style={styles.cardTitle}>
            {project.title}
          </Text>
          {project.visibility === 'private' ? <Icon name="lock" size={12} color={c.fgFaint} /> : null}
        </View>
        {project.description ? (
          <Text numberOfLines={1} style={styles.cardDesc}>
            {project.description}
          </Text>
        ) : null}
        <View style={styles.cardMetaRow}>
          <View style={[styles.statusPill, { backgroundColor: projectStatusTint(project.status, c) }]}>
            <Text style={[styles.statusPillText, { color: projectStatusColor(project.status, c) }]}>
              {projectStatusLabel(project.status, t)}
            </Text>
          </View>
          {project.priority !== 'normal' ? <Icon name="flag" size={12} color={priorityColor(project.priority, c)} /> : null}
          {stats ? <Text style={styles.cardMetaText}>{t('projects.taskCount', { done: stats.done, total: stats.total })}</Text> : null}
          {project.end_date ? (
            <View style={styles.cardMetaPair}>
              <Icon name="calendar" size={11} color={c.fgFaint} />
              <Text style={styles.cardMetaText}>{shortDate(project.end_date)}</Text>
            </View>
          ) : null}
        </View>
      </View>
      <ProgressRing pct={progress} size={44} color={project.color ?? undefined} />
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  filters: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16, paddingBottom: 10 },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: radius.full,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
  },
  filterChipText: { fontSize: font.small, color: c.fgSecondary, fontWeight: weight.medium },
  filterDivider: { width: 1, height: 18, backgroundColor: c.hairline, marginHorizontal: 2 },

  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    backgroundColor: c.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    padding: 14,
    marginBottom: 10,
  },
  cardTitleRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  cardDot: { width: 9, height: 9, borderRadius: 5 },
  cardTitle: { flex: 1, fontSize: font.title, fontWeight: weight.semibold, color: c.fg },
  cardDesc: { fontSize: font.small, color: c.fgMuted },
  cardMetaRow: { flexDirection: 'row', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
  statusPill: { paddingHorizontal: 8, paddingVertical: 2.5, borderRadius: radius.full },
  statusPillText: { fontSize: font.caption, fontWeight: weight.semibold },
  cardMetaText: { fontSize: font.caption, color: c.fgFaint },
  cardMetaPair: { flexDirection: 'row', alignItems: 'center', gap: 3 },

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
