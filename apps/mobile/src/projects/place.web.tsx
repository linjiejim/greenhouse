import ProjectBoard from './board';
import React, { useCallback, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Phone from './phone-screen';
import { listProjects, getProject, updateTaskStatus, gantt, createProject } from '../api/projects';
import { useResource } from '../data/use-resource';
import { captureIdentity } from '../data/identity';
import { PlaceSecondary } from '../shell/place-secondary.web';
import { useOpenObject } from '../shell/open-object';
import { Place, PlaceSidebar, PlaceRow, PlaceEmpty, PlaceContext, type PlaceContextPoint } from '../ui/place.web';
import { useT } from '../lib/i18n';
import { useAuth } from '../store/auth';
import { alertError, promptText } from '../ui/dialogs';
import { flattenTasks } from '../data/tasks';
import type { TaskStatus, ProjectTask } from '../shared/greenhouse-types';
export default function ProjectsPlace() {
  const { width } = useWindowDimensions();
  return width < 760 ? <Phone /> : <ProjectsDesktop />;
}
function ProjectsDesktop() {
  const t = useT(),
    router = useRouter(),
    open = useOpenObject();
  const { project: given } = useLocalSearchParams<{ project?: string }>();
  const [query, setQuery] = useState(''),
    [view, setView] = useState('kanban'),
    [mine, setMine] = useState(false),
    [saving, setSaving] = useState(false);
  const [context, setContext] = useState<PlaceContextPoint | null>(null);
  const user = useAuth((s) => s.user);
  const projects = useResource(useCallback(() => listProjects(captureIdentity()), []));
  const id = given ?? projects.data?.[0]?.id;
  const detail = useResource(
    useCallback(() => (id ? getProject(id) : Promise.resolve({ ok: true as const, data: null })), [id]),
  );
  const all = useResource(useCallback(() => gantt(), []));
  const tasks = (
    mine
      ? (all.data?.projects ?? [])
          .flatMap((p) => flattenTasks(p.tasks))
          .filter((task) => task.assignee_id === user?.id && task.status !== 'done' && task.status !== 'cancelled')
      : flattenTasks(detail.data?.tasks ?? [])
  ).filter((task) => !query || task.title.toLowerCase().includes(query.toLowerCase()));
  const openTask = (task: ProjectTask) => open({ kind: 'task', projectId: task.project_id, id: task.id });
  const statuses: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];
  const move = async (taskId: string, status: TaskStatus) => {
    if (saving) return;
    const task = tasks.find((t) => t.id === taskId);
    if (!task || task.status === status) return;
    const current = captureIdentity();
    setSaving(true);
    const previous = detail.data;
    detail.setData((value) =>
      value ? { ...value, tasks: value.tasks.map((t) => (t.id === taskId ? { ...t, status } : t)) } : value,
    );
    const r = await updateTaskStatus(taskId, status);
    if (!current()) return;
    setSaving(false);
    if (!r.ok) {
      detail.setData(previous);
      alertError(t('library.failed'), r.message);
    } else {
      void detail.refresh();
      void all.refresh();
    }
  };
  const newProject = async () => {
    const current = captureIdentity();
    const title = await promptText({ title: t('places.newProject') });
    if (!title || !current()) return;
    const r = await createProject(title);
    if (!current()) return;
    if (!r.ok) {
      alertError(t('library.failed'), r.message);
      return;
    }
    void projects.refresh();
    router.setParams({ project: r.data.project.id });
  };
  const item = (task: ProjectTask) => (
    <PlaceRow
      key={task.id}
      title={task.title}
      detail={task.due_date ?? undefined}
      icon="checkCircle"
      onOpen={() => openTask(task)}
      items={[
        { id: 'open', title: t('client.openInspector'), icon: 'open' },
        ...statuses.map((status) => ({ id: status, title: t(`projects.status.${status}` as never) })),
      ]}
      onSelect={(action) => (action === 'open' ? openTask(task) : void move(task.id, action as TaskStatus))}
    />
  );
  return (
    <>
      <PlaceSecondary>
        <PlaceSidebar
          title={t('nav.projects')}
          query={query}
          onQuery={setQuery}
          action={
            <button aria-label={t('places.newProject')} onClick={() => void newProject()}>
              +
            </button>
          }
        >
          <div data-place-list>
            <PlaceRow title={t('search.tasks')} icon="checkCircle" selected={mine} onOpen={() => setMine(true)} />
            {[
              ['active', 'planning'],
              ['on_hold', 'completed', 'archived'],
            ].map((group, i) => (
              <React.Fragment key={i}>
                <h3>{t(i ? 'places.archived' : 'places.active')}</h3>
                {projects.data
                  ?.filter((p) => group.includes(p.status))
                  .map((p) => (
                    <PlaceRow
                      key={p.id}
                      title={p.title}
                      detail={`${p.progress ?? 0}%`}
                      icon="checklist"
                      selected={!mine && p.id === id}
                      onOpen={() => {
                        setMine(false);
                        router.setParams({ project: p.id });
                      }}
                    />
                  ))}
              </React.Fragment>
            ))}
          </div>
        </PlaceSidebar>
      </PlaceSecondary>
      <Place
        title={mine ? t('search.tasks') : (detail.data?.project.title ?? t('nav.projects'))}
        actions={
          <>
            <div role="tablist" className="gh-place-tabs">
              {['kanban', 'list', 'gantt'].map((value) => (
                <button key={value} role="tab" aria-selected={view === value} onClick={() => setView(value)}>
                  {t(`places.${value}` as never)}
                </button>
              ))}
            </div>
            <button
              className="gh-primary"
              onClick={() => router.push({ pathname: '/task-form', params: { project: id } })}
            >
              {t('places.newTask')}
            </button>
          </>
        }
      >
        <div className="gh-place-scroll" data-place-list>
          {!tasks.length ? (
            <PlaceEmpty loading={detail.loading} error={detail.error?.message} retry={() => void detail.refresh()} />
          ) : view === 'list' ? (
            tasks.map(item)
          ) : (
            <ProjectBoard
              onContext={(id, x, y) => setContext({ id, x, y })}
              tasks={tasks}
              view={view}
              busy={saving}
              labels={Object.fromEntries([
                ...statuses.map((status) => [status, t(`projects.status.${status}` as never)]),
                ['status', t('places.sort')],
              ])}
              onOpen={(taskId) => {
                const task = tasks.find((task) => task.id === taskId);
                if (task) openTask(task);
              }}
              onMove={(id, status) => void move(id, status)}
            />
          )}
        </div>
      </Place>
      <PlaceContext
        point={context}
        close={() => setContext(null)}
        items={[
          {
            label: t('client.openInspector'),
            run: () => {
              const task = tasks.find((task) => task.id === context?.id);
              if (task) openTask(task);
            },
          },
          ...statuses.map((status) => ({
            label: t(`projects.status.${status}`),
            run: () => {
              if (context) void move(context.id, status);
            },
          })),
        ]}
      />
    </>
  );
}
