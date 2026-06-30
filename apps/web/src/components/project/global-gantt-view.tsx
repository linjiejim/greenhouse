/**
 * Global Gantt View — 跨项目全局时间线视图。
 *
 * 功能：按项目分组展开/折叠、TaskDetailDrawer 复用、拖拽创建任务、
 *       批量操作、拖拽排序（含跨项目移动）、乐观更新、右键菜单、MiniMap、
 *       展开状态持久化、键盘导航。
 *
 * 薄壳：数据加载/乐观更新/行模型构建/抽屉弹窗在此，渲染骨架在 GanttCore。
 */

import { useRef, useMemo, useEffect, useState, useCallback } from 'react';
import { TaskDetailDrawer } from './task-drawer';
import { CreateTaskDialog } from './create-task-dialog';
import { authFetch } from '../../lib/auth';
import { ChevronDown, ChevronRight, FolderKanban, Plus, MoreHorizontal, RefreshCw, Search } from '../../lib/icons';
import { toast, Spinner, Select, SearchInput } from '../ui';
import type { Task } from './types';
import {
  childProgress,
  collectParentIds,
  collectTaskDates,
  computeGanttRange,
  daysBetween,
  forEachTask,
  handleTaskAction,
  moveTask,
  patchTask,
  reorderTasks,
} from './gantt-utils';
import { GanttCore, GANTT_ROW_HEIGHT, ganttDayWidth } from './gantt-core';
import type { GanttBarTask, GanttGroupRow, GanttRow, GanttRowCtx, GanttTaskRow } from './gantt-core';
import { useT } from '../../lib/i18n';

// ─── Types ───────────────────────────────────────────────

export type GlobalGanttZoom = 'day' | 'week' | 'month' | 'year';

export interface GlobalGanttFilter {
  assignee?: string;
  status?: string;
  priority?: string;
  projectStatus?: string;
}

interface GanttProject {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  owner_id: string;
  owner_nickname: string;
  start_date: string | null;
  end_date: string | null;
  color: string;
  tasks: Task[];
  stats: { total: number; todo: number; in_progress: number; in_review: number; done: number; cancelled: number };
  progress: number;
}

type GlobalRow = GanttRow<GanttProject, GanttProject>;
type GlobalTaskRow = GanttTaskRow<GanttProject>;
type GlobalGroupRow = GanttGroupRow<GanttProject>;

// ─── Component ───────────────────────────────────────────

export function GlobalGanttView({
  zoom = 'month',
  filter,
  users,
  onNavigateToProject,
  onRefresh,
}: {
  zoom?: GlobalGanttZoom;
  filter?: GlobalGanttFilter;
  users?: Array<{ id: string; nickname: string }>;
  onNavigateToProject?: (projectId: number) => void;
  onRefresh?: () => void;
}) {
  const t = useT();

  const [projects, setProjects] = useState<GanttProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<number>>(() => {
    try {
      const saved = localStorage.getItem('global-gantt-expanded-projects');
      if (saved) return new Set(JSON.parse(saved) as number[]);
    } catch (_err) {
      /* ignore */
    }
    return new Set();
  });
  const [expandedTasks, setExpandedTasks] = useState<Set<number>>(() => {
    try {
      const saved = localStorage.getItem('global-gantt-expanded-tasks');
      if (saved) return new Set(JSON.parse(saved) as number[]);
    } catch (_err) {
      /* ignore */
    }
    return new Set();
  });

  // TaskDetailDrawer
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Create task dialog
  const [showCreate, setShowCreate] = useState(false);
  const [createProjectId, setCreateProjectId] = useState<number | undefined>();
  const [createParentId, setCreateParentId] = useState<number | undefined>();
  const [createDates, setCreateDates] = useState<{ start?: string; end?: string }>({});

  // Pending delete
  const [pendingDeleteTask, setPendingDeleteTask] = useState<Task | null>(null);

  // Search
  const [searchQuery, setSearchQuery] = useState('');

  // Resizable left panel
  const [labelWidth, setLabelWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('global-gantt-label-width');
      if (saved) return Math.max(200, Math.min(600, parseInt(saved, 10)));
    } catch (_err) {
      /* ignore */
    }
    return 360;
  });
  const resizingRef = useRef(false);

  const DAY_WIDTH = ganttDayWidth(zoom);
  const ROW_HEIGHT = GANTT_ROW_HEIGHT;

  // ── Load Data ──────────────────────────────────────────

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter?.projectStatus) params.set('status', filter.projectStatus);
      const res = await authFetch(`/api/projects/gantt?${params}`);
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects);
      }
    } catch (_err) {
      /* ignore */
    }
    setLoading(false);
    onRefresh?.();
  }, [filter?.projectStatus, onRefresh]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // ── Optimistic task update helper ─────────────────────

  const optimisticUpdateTask = useCallback((taskId: number, updates: Record<string, any>) => {
    setProjects((prev) =>
      prev.map((p) => ({
        ...p,
        tasks: updateTasksRecursive(p.tasks, taskId, updates),
      })),
    );
  }, []);

  // ── Toggle Helpers ─────────────────────────────────────

  const toggleProject = useCallback((id: number) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try {
        localStorage.setItem('global-gantt-expanded-projects', JSON.stringify([...next]));
      } catch (_err) {
        /* ignore */
      }
      return next;
    });
  }, []);

  const toggleTask = useCallback((id: number) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      try {
        localStorage.setItem('global-gantt-expanded-tasks', JSON.stringify([...next]));
      } catch (_err) {
        /* ignore */
      }
      return next;
    });
  }, []);

  const handleExpandAll = useCallback(() => {
    const pIds = new Set<number>();
    const tIds = new Set<number>();
    for (const p of projects) {
      pIds.add(p.id);
      collectParentIds(p.tasks, tIds);
    }
    setExpandedProjects(pIds);
    setExpandedTasks(tIds);
    try {
      localStorage.setItem('global-gantt-expanded-projects', JSON.stringify([...pIds]));
      localStorage.setItem('global-gantt-expanded-tasks', JSON.stringify([...tIds]));
    } catch (_err) {
      /* ignore */
    }
  }, [projects]);

  const handleCollapseAll = useCallback(() => {
    setExpandedProjects(new Set());
    setExpandedTasks(new Set());
    try {
      localStorage.removeItem('global-gantt-expanded-projects');
      localStorage.removeItem('global-gantt-expanded-tasks');
    } catch (_err) {
      /* ignore */
    }
  }, []);

  // ── Flatten Rows ───────────────────────────────────────

  const rows = useMemo<GlobalRow[]>(() => {
    const result: GlobalRow[] = [];
    const q = searchQuery.toLowerCase().trim();
    for (const p of projects) {
      result.push({ kind: 'group', key: `p-${p.id}`, data: p });
      if (!expandedProjects.has(p.id)) continue;

      function walkTasks(list: Task[], depth: number) {
        for (const tk of list) {
          if (filter?.assignee && tk.assignee_id !== filter.assignee) continue;
          if (filter?.status && tk.status !== filter.status) continue;
          if (filter?.priority && tk.priority !== filter.priority) continue;
          if (q && !tk.title.toLowerCase().includes(q)) {
            // Still walk children in case they match
            if (tk.children?.length) walkTasks(tk.children, depth + 1);
            continue;
          }

          const isParent = !!tk.children && tk.children.length > 0;
          result.push({ kind: 'task', key: `t-${tk.id}`, task: { ...tk, depth, isParent }, data: p });
          if (isParent && expandedTasks.has(tk.id) && tk.children?.length) {
            walkTasks(tk.children, depth + 1);
          }
        }
      }
      walkTasks(p.tasks, 1);
    }
    return result;
  }, [projects, expandedProjects, expandedTasks, filter, searchQuery]);

  const allFlatTasks = useMemo(() => {
    const all: Task[] = [];
    for (const p of projects) {
      forEachTask(p.tasks, (tk) => all.push(tk));
    }
    return all;
  }, [projects]);

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

  // ── Date Range ──────────────────────────────────────────

  const range = useMemo(() => {
    const dates: Date[] = [new Date()];
    for (const p of projects) {
      if (p.start_date) dates.push(new Date(p.start_date));
      if (p.end_date) dates.push(new Date(p.end_date));
      collectTaskDates(p.tasks, dates);
    }
    return computeGanttRange(dates);
  }, [projects]);

  // ── Bar progress / project bar ──────────────────────────

  const progressFor = useCallback((tk: GanttBarTask) => childProgress(tk, allFlatTasks), [allFlatTasks]);

  const getProjectBarStyle = useCallback(
    (p: GanttProject) => {
      let s = p.start_date ? new Date(p.start_date) : null;
      let e = p.end_date ? new Date(p.end_date) : null;
      if (!s || !e) {
        const dates = collectTaskDates(p.tasks);
        if (dates.length > 0) {
          if (!s) s = new Date(Math.min(...dates.map((d) => d.getTime())));
          if (!e) e = new Date(Math.max(...dates.map((d) => d.getTime())));
        }
      }
      if (!s && !e) return null;
      const barStart = s ?? e!;
      const barEnd = e ?? s!;
      const left = Math.floor((barStart.getTime() - range.startDate.getTime()) / 86400000) * DAY_WIDTH;
      const width = Math.max(1, Math.ceil((barEnd.getTime() - barStart.getTime()) / 86400000) + 1) * DAY_WIDTH;
      return { left, width };
    },
    [range.startDate, DAY_WIDTH],
  );

  // ── Drag (move/resize) persist — optimistic ────────────

  const handleBarDateChange = useCallback(
    async (task: Task, newStart: string | null, newEnd: string | null) => {
      // Optimistic update
      optimisticUpdateTask(task.id, { start_date: newStart, due_date: newEnd });
      await patchTask(task.id, { start_date: newStart, due_date: newEnd });
      // Background refresh for server truth
      loadData();
    },
    [loadData, optimisticUpdateTask],
  );

  // ── Drag-to-create ─────────────────────────────────────

  const handleDragCreate = useCallback(
    (startDateStr: string, endDateStr: string, rowIdx: number) => {
      // Find which project this row belongs to
      const row = rows[rowIdx];
      if (!row) return;
      const projectId = row.data.id;

      setCreateDates({ start: startDateStr, end: endDateStr });
      setCreateProjectId(projectId);
      setCreateParentId(undefined);
      setShowCreate(true);
    },
    [rows],
  );

  // ── Batch actions ───────────────────────────────────────

  const handleBatchAction = useCallback(
    async (action: string, value: string | undefined, ids: number[], clear: () => void) => {
      // Batch move to another project
      if (action === 'move' && value) {
        const targetProjectId = parseInt(value, 10);
        if (isNaN(targetProjectId)) return;
        for (const id of ids) optimisticUpdateTask(id, { project_id: targetProjectId });
        await Promise.all(ids.map((id) => moveTask(id, targetProjectId)));
        const targetName = projects.find((p) => p.id === targetProjectId)?.title || t('common.selectProject');
        toast(t('projects.movedToProject', { count: String(ids.length), target: targetName }), 'success');
        loadData();
        clear();
        return;
      }

      const updates: Record<string, string | null> = {};
      if (action === 'status' && value) updates.status = value;
      else if (action === 'assignee') updates.assignee_id = value || null;

      if (Object.keys(updates).length > 0) {
        // Optimistic
        for (const id of ids) optimisticUpdateTask(id, updates);
        // Server — parallel
        await Promise.all(ids.map((id) => patchTask(id, updates)));
        const count = ids.length;
        toast(t('projects.tasksUpdated', { count: String(count) }), 'success');
        loadData();
      }
      clear();
    },
    [optimisticUpdateTask, loadData, projects, t],
  );

  // ── Drag sort ───────────────────────────────────────────

  const handleSortDrop = useCallback(
    async (sourceId: number, targetIdx: number) => {
      // Get target row info
      const targetRow = rows[targetIdx];
      if (!targetRow || targetRow.kind !== 'task') return;
      const targetProjectId = targetRow.data.id;

      // Find source task and its project
      const sourceRow = rows.find((r): r is GlobalTaskRow => r.kind === 'task' && r.task.id === sourceId);
      if (!sourceRow) return;
      const sourceProjectId = sourceRow.data.id;

      // If dropping onto a parent task in the same project, reparent
      if (
        sourceProjectId === targetProjectId &&
        targetRow.task.isParent &&
        sourceRow.task.parent_id !== targetRow.task.id
      ) {
        await handleTaskAction(`reparent:${targetRow.task.id}`, sourceRow.task, {
          onRefresh: loadData,
          onOptimistic: optimisticUpdateTask,
        });
        return;
      }

      const isCrossProject = sourceProjectId !== targetProjectId;

      // Get all task rows in the target project
      const targetProjectTasks = rows
        .filter((r): r is GlobalTaskRow => r.kind === 'task' && r.data.id === targetProjectId)
        .map((r) => r.task);

      // Build reordered list (remove source if same project, or use as-is if cross-project)
      const reordered = isCrossProject ? [...targetProjectTasks] : targetProjectTasks.filter((t) => t.id !== sourceId);

      const localIdx = reordered.findIndex((t) => t.id === targetRow.task.id);
      const sourceTask = isCrossProject ? sourceRow.task : targetProjectTasks.find((t) => t.id === sourceId);
      if (!sourceTask) return;

      reordered.splice(localIdx >= 0 ? localIdx : reordered.length, 0, sourceTask);

      const updates = reordered.map((t, i) => ({
        id: t.id,
        sort_order: i * 10,
        ...(t.id === sourceId && isCrossProject ? { project_id: targetProjectId } : {}),
      }));

      try {
        // Optimistic update for cross-project move
        if (isCrossProject) {
          optimisticUpdateTask(sourceId, { project_id: targetProjectId });
        }
        await reorderTasks(updates);
        loadData();
        if (isCrossProject) {
          const oldProjectId = sourceProjectId;
          toast(t('projects.taskMovedToProject', { target: targetRow.data.title }), 'success', {
            onUndo: () => {
              moveTask(sourceId, oldProjectId).then(() => loadData());
            },
          });
        }
      } catch (_err) {
        loadData(); // Revert on failure
      }
    },
    [rows, loadData, optimisticUpdateTask, t],
  );

  // ── Context Menu ────────────────────────────────────────

  const handleContextAction = useCallback(
    async (action: string, task: Task) => {
      await handleTaskAction(action, task, {
        onRefresh: loadData,
        onSelect: (t) => setSelectedTask(t),
        onDelete: (t) => setPendingDeleteTask(t),
        onAddSubtask: (t) => {
          setCreateParentId(t.id);
          setCreateProjectId(t.project_id);
          setCreateDates({});
          setShowCreate(true);
        },
        onOptimistic: optimisticUpdateTask,
        resolveProjectName: (id) => projects.find((p) => p.id === id)?.title,
      });
    },
    [loadData, optimisticUpdateTask, projects],
  );

  // ── TaskDetailDrawer handlers ──────────────────────────

  const handleTaskUpdate = useCallback(() => {
    loadData();
  }, [loadData]);

  // ── Keyboard hooks (drawer/dialog interplay) ───────────

  const handleEscapeBefore = useCallback(() => {
    if (selectedTask) {
      setSelectedTask(null);
      return true;
    }
    return false;
  }, [selectedTask]);

  const handleEscapeAfter = useCallback(() => showCreate, [showCreate]); // handled by Dialog

  // ── Render helpers ──────────────────────────────────────

  const renderGroupRow = useCallback(
    (row: GlobalGroupRow) => {
      const p = row.data;
      const isExpanded = expandedProjects.has(p.id);
      return (
        <div
          className="flex items-center gap-2 px-3 border-b border-edge text-xs bg-surface-sunken/50 cursor-pointer hover:bg-surface-muted transition-colors"
          style={{ height: ROW_HEIGHT }}
        >
          <span
            className="w-4 h-4 flex items-center justify-center flex-shrink-0 cursor-pointer hover:bg-surface-muted rounded"
            onClick={(e) => {
              e.stopPropagation();
              toggleProject(p.id);
            }}
          >
            {isExpanded ? (
              <ChevronDown size={12} className="text-fg-muted" />
            ) : (
              <ChevronRight size={12} className="text-fg-muted" />
            )}
          </span>
          <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: p.color }} />
          <span
            className="font-semibold text-fg truncate flex-1 hover:text-primary-fg-strong transition-colors"
            title={p.title}
            onClick={() => onNavigateToProject?.(p.id)}
          >
            {p.title}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              setCreateProjectId(p.id);
              setCreateParentId(undefined);
              setCreateDates({});
              setShowCreate(true);
            }}
            className="p-0.5 text-fg-faint hover:text-primary-fg rounded opacity-0 hover:opacity-100 transition-opacity touch-visible"
            title="Add task"
          >
            <Plus size={12} />
          </button>
          <span className="text-[10px] text-fg-faint whitespace-nowrap flex-shrink-0">
            {p.stats.done}/{p.stats.total} · {p.progress}%
          </span>
        </div>
      );
    },
    [expandedProjects, ROW_HEIGHT, toggleProject, onNavigateToProject],
  );

  const renderTaskRow = useCallback(
    (row: GlobalTaskRow, ctx: GanttRowCtx) => {
      const tk = row.task;
      const p = row.data;
      const tkDays = daysBetween(tk.start_date, tk.due_date);
      return (
        <>
          {ctx.dragGrip}
          {ctx.expandToggle(tk)}
          {ctx.batchCheckbox(tk.id)}
          {ctx.statusIcon(tk)}
          <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 opacity-60" style={{ backgroundColor: p.color }} />
          {ctx.titleSpan(tk)}
          {tkDays != null && (
            <span
              className="text-[10px] text-fg-faint flex-shrink-0 w-6 text-right tabular-nums"
              title={`${tkDays} days`}
            >
              {tkDays}d
            </span>
          )}
          {ctx.assigneeSpan(tk)}
          <button
            className="flex-shrink-0 p-0.5 text-fg-faint hover:text-fg-secondary rounded opacity-0 group-hover/row:opacity-100 transition-opacity touch-visible"
            onClick={(e) => {
              e.stopPropagation();
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
              ctx.openContextMenu(rect.right, rect.top, tk);
            }}
            title={t('common.moreActions')}
          >
            <MoreHorizontal size={12} />
          </button>
        </>
      );
    },
    [t],
  );

  const renderGroupBar = useCallback(
    (row: GlobalGroupRow) => {
      const p = row.data;
      const pBar = getProjectBarStyle(p);
      return (
        <div className="relative border-b border-edge bg-surface-sunken/30" style={{ height: ROW_HEIGHT }}>
          {pBar && (
            <div
              className="absolute rounded-sm h-2.5 opacity-25"
              style={{
                left: pBar.left,
                width: Math.max(pBar.width, DAY_WIDTH),
                top: 13,
                backgroundColor: p.color,
              }}
              title={`${p.title}: ${p.start_date || '?'} → ${p.end_date || '?'}`}
            >
              <div
                className="h-full rounded-sm opacity-60"
                style={{ width: `${p.progress}%`, backgroundColor: p.color }}
              />
            </div>
          )}
        </div>
      );
    },
    [getProjectBarStyle, ROW_HEIGHT, DAY_WIDTH],
  );

  const barTooltip = useCallback(
    (row: GlobalTaskRow) =>
      `${row.task.title}\n${row.task.start_date || '?'} → ${row.task.due_date || '?'}\nProject: ${row.data.title}`,
    [],
  );

  const barLeftBorder = useCallback((row: GlobalTaskRow) => `2px solid ${row.data.color}`, []);

  // ── Render ──────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex justify-center items-center h-full">
        <Spinner className="text-primary-fg" />
      </div>
    );
  }

  if (projects.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-fg-faint">
        <FolderKanban size={40} className="mb-3" />
        <p className="text-sm">No projects found</p>
      </div>
    );
  }

  const leftHeader = (
    <div className="h-10 border-b border-edge bg-surface-sunken px-3 flex items-center gap-2 flex-shrink-0">
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <button
          onClick={handleExpandAll}
          className="text-[10px] text-fg-faint hover:text-primary-fg"
          title={t('projects.expandAll')}
        >
          ▼
        </button>
        <button
          onClick={handleCollapseAll}
          className="text-[10px] text-fg-faint hover:text-primary-fg"
          title={t('projects.collapseAll')}
        >
          ▶
        </button>
      </div>
      <div className="relative flex-1 min-w-0">
        <Search size={11} className="absolute left-1.5 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none" />
        <SearchInput value={searchQuery} onChange={setSearchQuery} placeholder={t('common.searchTasks')} size="sm" />
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={loadData}
          className="p-0.5 text-fg-faint hover:text-primary-fg rounded transition-colors"
          title={t('common.refresh')}
        >
          <RefreshCw size={12} />
        </button>
        <span className="text-[10px] text-fg-faint whitespace-nowrap">{projects.length}p</span>
      </div>
    </div>
  );

  const resizeHandle = (
    <div
      className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary-400/40 active:bg-primary-400/60 z-[10] transition-colors"
      onMouseDown={(e) => {
        e.preventDefault();
        resizingRef.current = true;
        const startX = e.clientX;
        const startWidth = labelWidth;
        const onMove = (ev: MouseEvent) => {
          const newWidth = Math.max(200, Math.min(600, startWidth + ev.clientX - startX));
          setLabelWidth(newWidth);
        };
        const onUp = () => {
          resizingRef.current = false;
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          try {
            localStorage.setItem('global-gantt-label-width', String(labelWidth));
          } catch (_err) {
            /* ignore */
          }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      }}
    />
  );

  return (
    <GanttCore
      rows={rows}
      zoom={zoom}
      range={range}
      users={users}
      labelWidth={labelWidth}
      indentBase={8}
      taskRowClassName="group/row"
      leftPanelClassName="relative"
      arrowMarkerId="global-arrowhead"
      leftHeader={leftHeader}
      leftPanelExtra={resizeHandle}
      isTaskExpanded={(id) => expandedTasks.has(id)}
      onToggleTask={toggleTask}
      renderTaskRow={renderTaskRow}
      renderGroupRow={renderGroupRow}
      renderGroupBar={renderGroupBar}
      progressFor={progressFor}
      barTooltip={barTooltip}
      barLeftBorder={barLeftBorder}
      onRowOpen={(task) => setSelectedTask(task)}
      onGroupEnter={(row) => toggleProject(row.data.id)}
      onBarDateChange={handleBarDateChange}
      onDragCreate={handleDragCreate}
      dragCreateByRow
      onSortDrop={handleSortDrop}
      onBatchAction={handleBatchAction}
      renderBatchExtra={(run) =>
        projects.length > 1 && (
          <>
            <span className="text-fg-faint">|</span>
            <span className="text-fg-muted">{t('common.moveTo')}</span>
            <Select
              onChange={(e) => {
                if (e.target.value) run('move', e.target.value);
              }}
              size="xs"
              inline
              defaultValue=""
            >
              <option value="" disabled>
                {t('common.selectProject')}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.title}
                </option>
              ))}
            </Select>
          </>
        )
      }
      contextMenuProjects={projects.map((p) => ({ id: p.id, title: p.title, color: p.color }))}
      contextMenuTasks={allFlatTasks}
      onContextAction={handleContextAction}
      pendingDeleteTask={pendingDeleteTask}
      setPendingDeleteTask={setPendingDeleteTask}
      onDeleted={() => loadData()}
      isModalOpen={!!selectedTask || showCreate}
      onEscapeBefore={handleEscapeBefore}
      onEscapeAfter={handleEscapeAfter}
    >
      {/* TaskDetailDrawer — full reuse */}
      <TaskDetailDrawer
        task={selectedTask}
        open={!!selectedTask}
        onClose={() => setSelectedTask(null)}
        onUpdate={handleTaskUpdate}
        users={users || []}
        allTasks={allFlatTasks}
      />

      {/* Create Task Dialog */}
      {createProjectId && (
        <CreateTaskDialog
          open={showCreate}
          onClose={() => {
            setShowCreate(false);
            setCreateDates({});
          }}
          onCreated={loadData}
          projectId={createProjectId}
          parentId={createParentId}
          users={users || []}
          initialStartDate={createDates.start}
          initialDueDate={createDates.end}
        />
      )}
    </GanttCore>
  );
}

// ── Helper: recursively update a task in nested tree ─────

function updateTasksRecursive(tasks: Task[], taskId: number, updates: Record<string, any>): Task[] {
  return tasks.map((t) => {
    if (t.id === taskId) return { ...t, ...updates };
    if (t.children?.length) return { ...t, children: updateTasksRecursive(t.children, taskId, updates) };
    return t;
  });
}
