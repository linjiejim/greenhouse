/**
 * Project Detail Page — /projects/:id
 *
 * 项目详情页，包含 List / Board / Gantt 三种视图，以及任务创建/编辑/评论。
 * 子组件拆分到 components/project/ 目录下。
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, EmptyState, Select, Spinner, Dialog, Drawer } from '../components/ui';
import { FormActions } from '../components/form';
import { useAgentContext } from '../components/agent-context';
import { authFetch } from '../lib/auth';
import { timeAgo } from '../lib/utils';
import {
  ArrowLeft,
  Plus,
  List,
  LayoutGrid,
  GanttChart,
  Calendar,
  User,
  Clock,
  Edit3,
  Users,
  Lock,
  FolderKanban,
} from '../lib/icons';
import { useT } from '../lib/i18n';
import { useAuthStore } from '../stores';
import { useInEntityPeek } from '../components/entity-peek';
import {
  type Task,
  type Project,
  type Activity,
  type ProjectMember,
  type GanttZoom,
  type GanttFilter,
  statusConfig,
  projectStatusConfig,
  priorityColors,
  TaskTreeItem,
  BoardColumn,
  GanttView,
  TaskDetailDrawer,
  CreateTaskDialog,
  MembersPanel,
  ProjectForm,
  type ProjectFormValue,
} from '../components/project';

// ─── Project Detail Page ─────────────────────────────────

export function ProjectDetailPage({ projectId }: { projectId: number }) {
  const inPeek = useInEntityPeek();
  const t = useT();
  const currentUser = useAuthStore((s) => s.currentUser);
  const [project, setProject] = useState<Project | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [allFlatTasks, setAllFlatTasks] = useState<Task[]>([]);
  const [stats, setStats] = useState<any>(null);
  const [progress, setProgress] = useState(0);
  const [loading, setLoading] = useState(true);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [showMembers, setShowMembers] = useState(false);
  const [view, setView] = useState<'list' | 'board' | 'gantt'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 768 ? 'list' : 'gantt',
  );
  const [ganttZoom, setGanttZoom] = useState<GanttZoom>('day');
  const [ganttFilter, setGanttFilter] = useState<GanttFilter>({});
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showCreate, setShowCreate] = useState(false);
  const [showCreateMilestone, setShowCreateMilestone] = useState(false);
  const [createParentId, setCreateParentId] = useState<number | undefined>();
  const [createDates, setCreateDates] = useState<{ start?: string; end?: string }>({});
  const [users, setUsers] = useState<Array<{ id: string; nickname: string }>>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [showActivities, setShowActivities] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [projectForm, setProjectForm] = useState<ProjectFormValue | null>(null);
  const [savingProject, setSavingProject] = useState(false);
  const { enrichPageContext } = useAgentContext();

  const loadProject = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/api/projects/${projectId}`);
      if (res.ok) {
        const data = await res.json();
        setProject(data.project);
        setTasks(data.tasks);
        setStats(data.stats);
        setProgress(data.progress);
        setMembers(data.members || []);
        // Collect flat tasks for drawer reference
        const flat: Task[] = [];
        function walk(list: Task[]) {
          for (const t of list) {
            flat.push(t);
            if (t.children?.length) walk(t.children);
          }
        }
        walk(data.tasks);
        setAllFlatTasks(flat);
        // Auto-expand top-level tasks
        setExpanded((prev) => {
          const next = new Set(prev);
          data.tasks.forEach((t: Task) => {
            if (t.children?.length) next.add(t.id);
          });
          return next;
        });
      }
    } catch (_err) {
      /* ignore */
    }
    setLoading(false);
  }, [projectId]);

  const loadUsers = useCallback(async () => {
    try {
      const res = await authFetch('/api/projects/meta/users');
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
    } catch (_err) {
      /* ignore */
    }
  }, []);

  const loadActivities = useCallback(async () => {
    try {
      const res = await authFetch(`/api/projects/${projectId}/activities?limit=30`);
      if (res.ok) {
        const data = await res.json();
        setActivities(data.activities);
      }
    } catch (_err) {
      /* ignore */
    }
  }, [projectId]);

  useEffect(() => {
    loadProject();
    loadUsers();
  }, [loadProject, loadUsers]);

  // Set agent context
  useEffect(() => {
    if (project) {
      enrichPageContext({ projectTitle: project.title });
    }
    return () => enrichPageContext(null);
  }, [project, enrichPageContext]);

  const handleToggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleTaskSelect = (task: Task) => {
    const fullTask = allFlatTasks.find((t) => t.id === task.id) ?? task;
    setSelectedTask(fullTask);
  };

  const handleTaskUpdate = () => {
    loadProject();
  };

  // Keep an open task drawer in sync with freshly-loaded data (e.g. after an
  // inline edit saves). Runs after the reload lands, so it reads the fresh
  // task list rather than a stale closure — no setTimeout race needed.
  useEffect(() => {
    setSelectedTask((prev) => {
      if (!prev) return prev;
      const fresh = allFlatTasks.find((tk) => tk.id === prev.id);
      return fresh ? { ...fresh } : prev;
    });
  }, [allFlatTasks]);

  const handleSaveProject = async () => {
    if (!project) return;
    setSavingProject(true);
    try {
      const res = await authFetch(`/api/projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projectForm),
      });
      if (res.ok) {
        setEditingProject(false);
        loadProject();
      }
    } catch (_err) {
      /* ignore */
    }
    setSavingProject(false);
  };

  if (loading) {
    return (
      <div className="flex justify-center items-center h-full">
        <Spinner className="text-primary-fg" />
      </div>
    );
  }

  if (!project) {
    return (
      <EmptyState
        icon={FolderKanban}
        variant="page"
        tone="danger"
        title={t('projects.projectNotFound')}
        action={
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              window.location.hash = '#/projects';
            }}
          >
            ← {t('projects.backToProjects')}
          </Button>
        }
      />
    );
  }

  const psc = projectStatusConfig[project.status] ?? projectStatusConfig.planning;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-3 md:px-6 py-3 border-b border-edge bg-surface-raised">
        <div className="flex items-start justify-between gap-2 mb-2">
          <div className="flex items-center gap-3 min-w-0">
            {!inPeek && (
              <button
                onClick={() => {
                  window.location.hash = '#/projects';
                }}
                className="text-fg-faint hover:text-fg-secondary flex-shrink-0"
              >
                <ArrowLeft size={18} />
              </button>
            )}
            <h1 className="text-base font-semibold text-fg truncate">{project.title}</h1>
            <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium whitespace-nowrap ${psc.color}`}>
              {t(psc.label)}
            </span>
            {project.priority !== 'normal' && (
              <span className={`text-[10px] font-medium ${priorityColors[project.priority]}`}>{project.priority}</span>
            )}
            {project.visibility === 'private' && (
              <span className="flex items-center gap-0.5 text-[10px] text-fg-faint">
                <Lock size={10} />
                {t('projects.visibilityPrivate')}
              </span>
            )}
          </div>
          <div className="flex flex-shrink-0 items-center gap-1 sm:gap-2">
            {/* Members avatars */}
            <button
              onClick={() => setShowMembers(true)}
              className="inline-flex h-9 w-9 sm:h-auto sm:w-auto items-center justify-center gap-1 sm:px-2 sm:py-1 text-xs text-fg-muted hover:text-primary-fg rounded-md hover:bg-surface-muted transition-colors"
              title={t('projects.members')}
            >
              <Users size={13} />
              <span className="hidden sm:inline">{members.length}</span>
            </button>
            <button
              onClick={() => {
                setEditingProject(true);
                setProjectForm({
                  title: project.title,
                  description: project.description || '',
                  status: project.status,
                  priority: project.priority,
                  owner_id: project.owner_id,
                  start_date: project.start_date || '',
                  end_date: project.end_date || '',
                  color: project.color || '',
                  visibility: project.visibility || 'public',
                });
              }}
              className="inline-flex h-9 w-9 items-center justify-center text-fg-faint hover:text-primary-fg rounded-md hover:bg-surface-muted"
              title={t('projects.editProject')}
            >
              <Edit3 size={14} />
            </button>
            <button
              onClick={() => {
                setShowActivities(true);
                loadActivities();
              }}
              className="inline-flex h-9 w-9 items-center justify-center text-fg-faint hover:text-primary-fg rounded-md hover:bg-surface-muted"
              title={t('projects.changelog')}
            >
              <Clock size={14} />
            </button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="flex items-center gap-4 text-xs text-fg-muted flex-wrap">
          <span className="flex items-center gap-1">
            <User size={11} />
            {project.owner_nickname}
          </span>
          {project.start_date && (
            <span className="flex items-center gap-1">
              <Calendar size={11} />
              {project.start_date} ~ {project.end_date || '?'}
            </span>
          )}
          <span className="flex items-center gap-1">
            {t('projects.taskProgress', { done: stats?.done ?? 0, total: stats?.total ?? 0, progress })}
          </span>
          {stats && (
            <div className="flex-1 max-w-[200px] h-1.5 bg-surface-muted rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-primary-500 transition-all" style={{ width: `${progress}%` }} />
            </div>
          )}
        </div>
      </div>

      {/* View tabs + Zoom + Filter + Add Task */}
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 md:px-6 py-2 border-b border-edge bg-surface-sunken/50">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-0.5 bg-surface-muted p-0.5 rounded-lg">
            {[
              { key: 'gantt' as const, icon: GanttChart, label: t('projects.gantt'), hideOnMobile: true },
              { key: 'list' as const, icon: List, label: t('projects.list'), hideOnMobile: false },
              { key: 'board' as const, icon: LayoutGrid, label: t('projects.board'), hideOnMobile: false },
            ].map((v) => (
              <button
                key={v.key}
                onClick={() => setView(v.key)}
                className={`items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${
                  view === v.key
                    ? 'bg-surface-raised text-primary-fg-strong font-medium shadow-sm'
                    : 'text-fg-muted hover:text-fg-secondary'
                } ${v.hideOnMobile ? 'hidden md:flex' : 'flex'}`}
              >
                <v.icon size={13} />
                {v.label}
              </button>
            ))}
          </div>
          {view === 'gantt' && (
            <>
              <div className="hidden sm:flex items-center gap-0.5 bg-surface-muted p-0.5 rounded-lg">
                {(['day', 'week', 'month', 'year'] as GanttZoom[]).map((z) => (
                  <button
                    key={z}
                    onClick={() => setGanttZoom(z)}
                    className={`px-2 py-1 rounded-md text-[11px] transition-colors ${
                      ganttZoom === z
                        ? 'bg-surface-raised text-primary-fg-strong font-medium shadow-sm'
                        : 'text-fg-muted hover:text-fg-secondary'
                    }`}
                  >
                    {t(`projects.${z}` as 'projects.day' | 'projects.week' | 'projects.month' | 'projects.year')}
                  </button>
                ))}
              </div>
              <span className="hidden sm:inline text-fg-faint">|</span>
              <Select
                value={ganttFilter.status || ''}
                onChange={(e) => setGanttFilter({ ...ganttFilter, status: e.target.value || undefined })}
                className="hidden sm:block"
                size="xs"
                inline
              >
                <option value="">{t('projects.allStatus')}</option>
                {Object.entries(statusConfig).map(([k, v]) => (
                  <option key={k} value={k}>
                    {t(v.label)}
                  </option>
                ))}
              </Select>
              <Select
                value={ganttFilter.assignee || ''}
                onChange={(e) => setGanttFilter({ ...ganttFilter, assignee: e.target.value || undefined })}
                className="hidden sm:block"
                size="xs"
                inline
              >
                <option value="">{t('projects.allAssignees')}</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.nickname}
                  </option>
                ))}
              </Select>
              <Select
                value={ganttFilter.priority || ''}
                onChange={(e) => setGanttFilter({ ...ganttFilter, priority: e.target.value || undefined })}
                className="hidden sm:block"
                size="xs"
                inline
              >
                <option value="">{t('projects.allPriority')}</option>
                <option value="urgent">{t('common.urgent')}</option>
                <option value="high">{t('common.high')}</option>
                <option value="normal">{t('common.normal')}</option>
                <option value="low">{t('common.low')}</option>
              </Select>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setShowCreateMilestone(true);
            }}
          >
            <span className="mr-1 text-warning">◆</span> {t('projects.milestone')}
          </Button>
          <Button
            size="sm"
            onClick={() => {
              setCreateParentId(undefined);
              setCreateDates({});
              setShowCreate(true);
            }}
          >
            <Plus size={14} className="mr-1" /> {t('projects.addTask')}
          </Button>
        </div>
      </div>

      {/* View content */}
      <div className="flex-1 overflow-hidden">
        {view === 'list' && (
          <div className="h-full overflow-y-auto">
            {tasks.length === 0 ? (
              <EmptyState icon={List} title={t('projects.noTasks')} />
            ) : (
              tasks.map((t) => (
                <TaskTreeItem
                  key={t.id}
                  task={t}
                  depth={0}
                  onSelect={handleTaskSelect}
                  expanded={expanded}
                  onToggle={handleToggle}
                />
              ))
            )}
          </div>
        )}

        {view === 'board' && (
          <div className="h-full overflow-x-auto p-3 md:p-4">
            <div className="flex flex-col md:flex-row gap-3 md:min-w-max">
              {['todo', 'in_progress', 'in_review', 'done'].map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  tasks={allFlatTasks}
                  onSelect={handleTaskSelect}
                  onStatusChange={async (taskId, newStatus) => {
                    await authFetch(`/api/projects/tasks/${taskId}`, {
                      method: 'PATCH',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ status: newStatus }),
                    });
                    loadProject();
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {view === 'gantt' && (
          <GanttView
            tasks={tasks}
            project={project}
            onSelect={(task) => {
              loadProject();
              handleTaskSelect(task);
            }}
            zoom={ganttZoom}
            filter={ganttFilter}
            onDragCreate={(startDate, endDate) => {
              setCreateDates({ start: startDate, end: endDate });
              setCreateParentId(undefined);
              setShowCreate(true);
            }}
            users={users}
            onContextAction={(action, task) => {
              if (action === 'edit') {
                handleTaskSelect(task);
              } else if (action === 'add-subtask') {
                setCreateParentId(task.id);
                setCreateDates({});
                setShowCreate(true);
              }
            }}
            onBatchUpdate={async (taskIds, updates) => {
              for (const id of taskIds) {
                await authFetch(`/api/projects/tasks/${id}`, {
                  method: 'PATCH',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify(updates),
                });
              }
              loadProject();
            }}
          />
        )}
      </div>

      {/* Task Detail Drawer */}
      <TaskDetailDrawer
        task={selectedTask}
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
        onUpdate={handleTaskUpdate}
        users={users}
        allTasks={allFlatTasks}
      />

      {/* Create Task Dialog */}
      <CreateTaskDialog
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          setCreateDates({});
        }}
        onCreated={loadProject}
        projectId={projectId}
        parentId={createParentId}
        users={users}
        initialStartDate={createDates.start}
        initialDueDate={createDates.end}
      />

      {/* Create Milestone Dialog */}
      <CreateTaskDialog
        open={showCreateMilestone}
        onClose={() => setShowCreateMilestone(false)}
        onCreated={loadProject}
        projectId={projectId}
        users={users}
        taskType="milestone"
      />

      {/* Edit Project Dialog */}
      <Dialog
        open={editingProject}
        onClose={() => setEditingProject(false)}
        title={t('projects.editProject')}
        size="md"
      >
        {projectForm && (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSaveProject();
            }}
          >
            <ProjectForm value={projectForm} onChange={setProjectForm} showStatus />
            <FormActions>
              <Button variant="ghost" size="sm" type="button" onClick={() => setEditingProject(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" type="submit" disabled={savingProject}>
                {savingProject ? t('common.saving') : t('common.save')}
              </Button>
            </FormActions>
          </form>
        )}
      </Dialog>

      {/* Activities Drawer */}
      <Drawer open={showActivities} onClose={() => setShowActivities(false)} side="right" width={360}>
        <div className="px-4 py-3 border-b border-edge">
          <h3 className="text-sm font-semibold text-fg flex items-center gap-2">
            <Clock size={14} className="text-primary-fg" />
            {t('projects.changelog')}
          </h3>
        </div>
        <div className="overflow-y-auto flex-1 px-4 py-3">
          {activities.length === 0 ? (
            <EmptyState icon={Clock} title={t('common.noRecords')} variant="compact" tone="neutral" />
          ) : (
            <div className="space-y-3">
              {activities.map((a) => (
                <div key={a.id} className="flex gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-primary-400 mt-1.5 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs text-fg-secondary">{a.detail || a.action}</p>
                    <div className="flex items-center gap-2 mt-0.5 text-[10px] text-fg-faint">
                      <span>{a.user_nickname}</span>
                      <span>{timeAgo(a.created_at)}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Drawer>

      {/* Members Panel */}
      <MembersPanel
        open={showMembers}
        onClose={() => setShowMembers(false)}
        projectId={projectId}
        members={members}
        users={users}
        onUpdate={loadProject}
        currentUserId={currentUser?.id ?? ''}
        isOwner={
          members.some((m) => m.user_id === currentUser?.id && m.role === 'owner') || currentUser?.role === 'super'
        }
      />
    </div>
  );
}
