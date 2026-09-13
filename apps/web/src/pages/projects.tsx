/**
 * Projects List Page — /projects
 *
 * 项目列表页，展示所有项目卡片，包含进度、状态筛选等。
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Button, EmptyState, Select, Spinner, Dialog, SearchInput } from '../components/ui';
import { ModulePage } from '../components/app/module-page';
import { FormActions, FormError } from '../components/form';
import { authFetch } from '../lib/auth';
import {
  FolderKanban,
  Plus,
  // Search icon no longer needed — SearchInput handles it internally
  Calendar,
  User,
  ChevronRight,
  BarChart3,
  AlertTriangle,
  LayoutGrid,
  GanttChart,
  Lock,
} from '../lib/icons';
import {
  GlobalGanttView,
  ProjectForm,
  EMPTY_PROJECT_FORM,
  type ProjectFormValue,
  type GlobalGanttZoom,
  type GlobalGanttFilter,
  statusConfig as taskStatusConfig,
} from '../components/project';
import { useT, type TranslationKey } from '../lib/i18n';
import { invalidateProjects, useProjectRefreshStore } from '../stores';

// ─── Types ───────────────────────────────────────────────

interface ProjectStats {
  total: number;
  todo: number;
  in_progress: number;
  in_review: number;
  done: number;
  cancelled: number;
}

interface Project {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  owner_id: string;
  owner_nickname: string;
  start_date: string | null;
  end_date: string | null;
  created_at: string;
  updated_at: string;
  stats: ProjectStats;
  progress: number;
  visibility?: 'public' | 'private';
}

// ─── Status/Priority Badges ─────────────────────────────

const statusConfig: Record<string, { label: TranslationKey; color: string }> = {
  planning: { label: 'projects.planning', color: 'bg-surface-muted text-fg-secondary border-edge' },
  active: { label: 'common.active', color: 'bg-info-subtle text-info border-info' },
  on_hold: { label: 'projects.onHold', color: 'bg-warning-subtle text-warning-fg border-warning' },
  completed: { label: 'common.completed', color: 'bg-success-subtle text-success-fg border-success' },
  archived: { label: 'common.archived', color: 'bg-surface-sunken text-fg-faint border-edge' },
};

const priorityConfig: Record<string, { label: TranslationKey; color: string }> = {
  low: { label: 'common.low', color: 'text-fg-faint' },
  normal: { label: 'common.normal', color: 'text-info' },
  high: { label: 'common.high', color: 'text-warning' },
  urgent: { label: 'common.urgent', color: 'text-danger' },
};

// ─── Progress Bar ────────────────────────────────────────

function ProgressBar({ progress, stats }: { progress: number; stats: ProjectStats }) {
  const t = useT();
  if (stats.total === 0) return <span className="text-xs text-fg-faint">{t('projects.noTasks')}</span>;

  return (
    <div className="flex items-center gap-2 w-full">
      <div className="flex-1 h-1.5 bg-surface-muted rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-300 bg-primary-500"
          style={{ width: `${progress}%` }}
        />
      </div>
      <span className="text-xs text-fg-muted whitespace-nowrap font-mono">{progress}%</span>
    </div>
  );
}

// ─── Project Card ────────────────────────────────────────

function ProjectCard({ project, onClick }: { project: Project; onClick: () => void }) {
  const t = useT();
  const sc = statusConfig[project.status] ?? statusConfig.planning;
  const pc = priorityConfig[project.priority] ?? priorityConfig.normal;
  const isOverdue =
    project.end_date &&
    new Date(project.end_date) < new Date() &&
    project.status !== 'completed' &&
    project.status !== 'archived';

  return (
    <div
      onClick={onClick}
      className={`bg-surface-raised border rounded-xl p-4 hover:border-primary-300 hover:shadow-sm transition-all cursor-pointer group ${isOverdue ? 'border-danger' : 'border-edge'}`}
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3
              className="text-sm font-semibold text-fg truncate group-hover:text-primary-fg-strong transition-colors"
              title={project.title}
            >
              {project.title}
            </h3>
            {project.visibility === 'private' && <Lock size={11} className="text-fg-faint flex-shrink-0" />}
            {project.priority !== 'normal' && (
              <span className={`text-[10px] font-medium ${pc.color}`}>{t(pc.label)}</span>
            )}
          </div>
          {project.description && <p className="text-xs text-fg-muted line-clamp-1">{project.description}</p>}
        </div>
        <span className={`text-[10px] px-2 py-0.5 rounded-full border font-medium whitespace-nowrap ${sc.color}`}>
          {t(sc.label)}
        </span>
      </div>

      <ProgressBar progress={project.progress} stats={project.stats} />

      <div className="flex items-center justify-between mt-3 text-xs text-fg-faint">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <User size={11} />
            {project.owner_nickname}
          </span>
          <span className="flex items-center gap-1">
            <BarChart3 size={11} />
            {project.stats.done}/{project.stats.total}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {isOverdue && (
            <span className="flex items-center gap-0.5 text-danger">
              <AlertTriangle size={11} />
              {t('projects.overdue')}
            </span>
          )}
          {project.end_date && (
            <span className="flex items-center gap-1">
              <Calendar size={11} />
              {project.end_date}
            </span>
          )}
          <ChevronRight size={14} className="text-fg-faint group-hover:text-primary-500 transition-colors" />
        </div>
      </div>
    </div>
  );
}

// ─── Create Project Dialog ───────────────────────────────

function CreateProjectDialog({
  open,
  onClose,
  onCreated,
  users,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  users: Array<{ id: string; nickname: string }>;
}) {
  const t = useT();
  const [form, setForm] = useState<ProjectFormValue>(EMPTY_PROJECT_FORM);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!form.title.trim()) {
      setError(t('projects.projectNameRequired'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await authFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: form.title.trim(),
          description: form.description || undefined,
          priority: form.priority,
          status: form.status,
          owner_id: form.owner_id || undefined,
          start_date: form.start_date || undefined,
          end_date: form.end_date || undefined,
          color: form.color || undefined,
          visibility: form.visibility,
        }),
      });
      if (res.ok) {
        setForm(EMPTY_PROJECT_FORM);
        onCreated();
        onClose();
      } else {
        const data = await res.json();
        setError(data.error || t('common.createFailed'));
      }
    } catch (_err) {
      setError(t('common.networkError'));
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('projects.createProject')} size="lg">
      <form
        data-testid="project-create-dialog"
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
      >
        <ProjectForm value={form} onChange={setForm} users={users} showOwner />
        <FormError>{error}</FormError>
        <FormActions>
          <Button variant="ghost" size="sm" type="button" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" type="submit" disabled={saving} data-testid="project-create-submit">
            {saving ? t('projects.creating') : t('common.create')}
          </Button>
        </FormActions>
      </form>
    </Dialog>
  );
}

// ─── Projects Page ───────────────────────────────────────

export function ProjectsPage() {
  const t = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'cards' | 'gantt'>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 768) return 'cards';
    try {
      const saved = localStorage.getItem('projects-view');
      if (saved === 'cards' || saved === 'gantt') return saved;
    } catch (_err) {
      /* ignore */
    }
    return 'gantt';
  });
  const [statusFilter, setStatusFilter] = useState('');
  const [priorityFilter, setPriorityFilter] = useState('');
  const [search, setSearch] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [users, setUsers] = useState<Array<{ id: string; nickname: string }>>([]);
  const projectsRevision = useProjectRefreshStore((state) => state.revision);

  // Gantt-specific state
  const [ganttZoom, setGanttZoom] = useState<GlobalGanttZoom>(() => {
    try {
      const saved = localStorage.getItem('projects-gantt-zoom');
      if (saved === 'day' || saved === 'week' || saved === 'month' || saved === 'year') return saved;
    } catch (_err) {
      /* ignore */
    }
    return 'month';
  });
  const [ganttFilter, setGanttFilter] = useState<GlobalGanttFilter>({});

  // Persist view and zoom to localStorage
  const handleViewChange = useCallback((v: 'cards' | 'gantt') => {
    setView(v);
    try {
      localStorage.setItem('projects-view', v);
    } catch (_err) {
      /* ignore */
    }
  }, []);
  const handleZoomChange = useCallback((z: GlobalGanttZoom) => {
    setGanttZoom(z);
    try {
      localStorage.setItem('projects-gantt-zoom', z);
    } catch (_err) {
      /* ignore */
    }
  }, []);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter) params.set('status', statusFilter);
      if (priorityFilter) params.set('priority', priorityFilter);
      if (search) params.set('search', search);
      const res = await authFetch(`/api/projects?${params}`);
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects);
      }
    } catch (_err) {
      /* ignore */
    }
    setLoading(false);
  }, [statusFilter, priorityFilter, search]);

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

  useEffect(() => {
    loadProjects();
  }, [loadProjects, projectsRevision]);
  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  return (
    <ModulePage
      moduleId="workspace.projects"
      layout="canvas"
      actions={
        <Button size="sm" onClick={() => setShowCreate(true)} data-testid="projects-new">
          <Plus size={14} className="mr-1" /> {t('projects.createProject')}
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          {/* View toggle */}
          <div className="flex items-center gap-0.5 bg-surface-muted p-0.5 rounded-lg">
            {[
              { key: 'cards' as const, icon: LayoutGrid, label: t('projects.cards') },
              { key: 'gantt' as const, icon: GanttChart, label: t('projects.globalGantt'), hideOnMobile: true },
            ].map((v) => (
              <button
                key={v.key}
                onClick={() => handleViewChange(v.key)}
                className={`flex items-center gap-1 px-2.5 py-1 rounded-md text-xs transition-colors ${
                  view === v.key
                    ? 'bg-surface-raised text-primary-fg-strong font-medium shadow-sm'
                    : 'text-fg-muted hover:text-fg-secondary'
                } ${'hideOnMobile' in v && v.hideOnMobile ? 'hidden md:flex' : ''}`}
              >
                <v.icon size={13} />
                {v.label}
              </button>
            ))}
          </div>

          {view === 'cards' && (
            <>
              <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} size="sm" inline>
                <option value="">{t('projects.allStatus')}</option>
                {Object.entries(statusConfig).map(([value, config]) => (
                  <option key={value} value={value}>
                    {t(config.label)}
                  </option>
                ))}
              </Select>
              <Select
                value={priorityFilter}
                onChange={(e) => setPriorityFilter(e.target.value)}
                className=""
                size="sm"
                inline
              >
                <option value="">{t('projects.allPriority')}</option>
                <option value="urgent">{t('common.urgent')}</option>
                <option value="high">{t('common.high')}</option>
                <option value="normal">{t('common.normal')}</option>
                <option value="low">{t('common.low')}</option>
              </Select>
              <div className="relative flex-1 min-w-[120px] max-w-[240px]">
                <SearchInput value={search} onChange={setSearch} size="sm" placeholder={t('projects.searchProjects')} />
              </div>
            </>
          )}

          {view === 'gantt' && (
            <>
              <div className="hidden sm:flex items-center gap-0.5 bg-surface-muted p-0.5 rounded-lg">
                {(['day', 'week', 'month', 'year'] as GlobalGanttZoom[]).map((z) => (
                  <button
                    key={z}
                    onClick={() => handleZoomChange(z)}
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
                value={ganttFilter.projectStatus || ''}
                onChange={(e) => setGanttFilter({ ...ganttFilter, projectStatus: e.target.value || undefined })}
                className="hidden sm:block"
                size="xs"
                inline
                aria-label={t('projects.allProjects')}
              >
                <option value="">{t('projects.allProjects')}</option>
                {Object.entries(statusConfig)
                  .filter(([value]) => value !== 'archived')
                  .map(([value, config]) => (
                    <option key={value} value={value}>
                      {t(config.label)}
                    </option>
                  ))}
              </Select>
              <Select
                value={ganttFilter.status || ''}
                onChange={(e) => setGanttFilter({ ...ganttFilter, status: e.target.value || undefined })}
                className="hidden sm:block"
                size="xs"
                inline
                aria-label={t('projects.allTaskStatus')}
              >
                <option value="">{t('projects.allTaskStatus')}</option>
                {Object.entries(taskStatusConfig).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
              {users.length > 0 && (
                <Select
                  value={ganttFilter.assignee || ''}
                  onChange={(e) => setGanttFilter({ ...ganttFilter, assignee: e.target.value || undefined })}
                  className="hidden sm:block"
                  size="xs"
                  inline
                  aria-label={t('projects.allAssignees')}
                >
                  <option value="">{t('projects.allAssignees')}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.nickname}
                    </option>
                  ))}
                </Select>
              )}
            </>
          )}
          {view === 'cards' && <span className="ml-auto text-xs text-fg-faint">{projects.length}</span>}
        </div>
      }
    >
      {/* Content */}
      {view === 'cards' ? (
        <div className="h-full overflow-y-auto py-1">
          {loading ? (
            <div className="flex justify-center py-12">
              <Spinner className="text-primary-fg" />
            </div>
          ) : projects.length === 0 ? (
            <EmptyState
              icon={FolderKanban}
              title={t('projects.noProjects')}
              description={t('projects.createFirstProject')}
            />
          ) : (
            <div className="grid gap-3 grid-cols-1 lg:grid-cols-2 xl:grid-cols-3">
              {projects.map((p) => (
                <ProjectCard
                  key={p.id}
                  project={p}
                  onClick={() => {
                    window.location.hash = `#/projects/${p.id}`;
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="h-full overflow-hidden">
          <GlobalGanttView
            zoom={ganttZoom}
            filter={ganttFilter}
            users={users}
            onNavigateToProject={(id) => {
              window.location.hash = `#/projects/${id}`;
            }}
            onRefresh={loadProjects}
          />
        </div>
      )}

      {/* Create Dialog */}
      <CreateProjectDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={invalidateProjects}
        users={users}
      />
    </ModulePage>
  );
}
