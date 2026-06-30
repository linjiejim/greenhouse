/**
 * Right-click context menu for Gantt chart tasks.
 * Enhanced with: move to project, set milestone, reparent (变为子任务),
 * view, edit, delete, set predecessor.
 */

import { useRef, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus, Trash2, Edit3, Eye, FolderKanban, ChevronRight, CornerDownRight } from '../../lib/icons';
import type { Task } from './types';
import { parseDeps } from './gantt-utils';
import { useT } from '../../lib/i18n';

export interface GanttContextMenuProject {
  id: number;
  title: string;
  color: string;
}

export function GanttContextMenu({
  x,
  y,
  task,
  onClose,
  onAction,
  projects,
  allTasks,
}: {
  x: number;
  y: number;
  task: Task;
  onClose: () => void;
  onAction: (action: string, task: Task) => void;
  projects?: GanttContextMenuProject[];
  allTasks?: Task[];
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<'move' | 'dep' | 'reparent' | null>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);

  // Adjust position to stay within viewport
  useEffect(() => {
    if (menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menuRef.current.style.left = `${x - rect.width}px`;
      }
      if (rect.bottom > window.innerHeight) {
        menuRef.current.style.top = `${y - rect.height}px`;
      }
    }
  }, [x, y]);

  const isMilestone = task.task_type === 'milestone';
  const otherProjects = projects?.filter((p) => p.id !== task.project_id) || [];

  // Available tasks for setting as predecessor (exclude self and descendants)
  const descendantIds = new Set<number>();
  function collectDescendants(parentId: number) {
    for (const t of allTasks || []) {
      if (t.parent_id === parentId) {
        descendantIds.add(t.id);
        collectDescendants(t.id);
      }
    }
  }
  collectDescendants(task.id);

  const sameProjTasks = (allTasks || []).filter(
    (t) => t.id !== task.id && t.project_id === task.project_id && !descendantIds.has(t.id),
  );
  const currentDeps = parseDeps(task.dependencies);

  // Potential parents: same project tasks that are not this task, not a descendant, not already a child
  const potentialParents = sameProjTasks.filter((t) => t.id !== task.parent_id);

  type MenuItem =
    | { type: 'divider' }
    | { label: string; action: string; icon?: any; danger?: boolean; hasSubmenu?: boolean; show?: boolean };

  const t = useT();

  const divider: MenuItem = { type: 'divider' };

  const items: MenuItem[] = [
    // Status changes
    { label: '→ Todo', action: 'status:todo', show: task.status !== 'todo' },
    { label: '→ In Progress', action: 'status:in_progress', show: task.status !== 'in_progress' },
    { label: '→ In Review', action: 'status:in_review', show: task.status !== 'in_review' },
    { label: '→ Done', action: 'status:done', show: task.status !== 'done' },
    divider,
    // View & Edit
    { label: t('common.viewDetails'), action: 'view', icon: Eye },
    { label: t('task.editTask'), action: 'edit', icon: Edit3 },
    divider,
    // Milestone toggle
    {
      label: isMilestone ? t('task.unsetMilestone') : t('task.setMilestone'),
      action: isMilestone ? 'type:task' : 'type:milestone',
    },
    // Add subtask
    { label: t('task.addSubtask'), action: 'add-subtask', icon: Plus },
    // Reparent (#1 — 变为子任务)
    ...(potentialParents.length > 0
      ? [
          { label: t('task.reparent'), action: 'reparent-submenu', icon: CornerDownRight, hasSubmenu: true },
          ...(task.parent_id ? [{ label: t('task.removeParent'), action: 'reparent:null' }] : []),
        ]
      : []),
    divider,
    // Move to project (with submenu)
    ...(otherProjects.length > 0
      ? [{ label: t('task.moveToProject'), action: 'move-submenu', icon: FolderKanban, hasSubmenu: true }]
      : []),
    // Set predecessor (with submenu)
    ...(sameProjTasks.length > 0 ? [{ label: t('task.setBlocker'), action: 'dep-submenu', hasSubmenu: true }] : []),
    divider,
    // Delete
    { label: t('task.deleteTask'), action: 'delete', icon: Trash2, danger: true },
  ].filter((item) => 'type' in item || (item as any).show !== false);

  const openSubmenu = (sub: typeof activeSubmenu) => setActiveSubmenu(sub);

  return (
    <div
      ref={menuRef}
      className="fixed bg-surface-raised rounded-lg shadow-xl border border-edge py-1 z-[60] min-w-[180px]"
      style={{ left: x, top: y }}
    >
      {items.map((item, i) => {
        if ('type' in item && item.type === 'divider') {
          return <div key={i} className="border-t border-edge my-1" />;
        }
        const menuItem = item as {
          label: string;
          action: string;
          icon?: any;
          danger?: boolean;
          hasSubmenu?: boolean;
        };

        // Move to project submenu
        if (menuItem.action === 'move-submenu') {
          return (
            <SubmenuTrigger
              key={i}
              menuItem={menuItem}
              active={activeSubmenu === 'move'}
              onEnter={() => openSubmenu('move')}
            >
              {otherProjects.map((p) => (
                <SubmenuButton
                  key={p.id}
                  onClick={() => {
                    onAction(`move:${p.id}`, task);
                    onClose();
                  }}
                >
                  <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ backgroundColor: p.color }} />
                  <span className="truncate">{p.title}</span>
                </SubmenuButton>
              ))}
            </SubmenuTrigger>
          );
        }

        // Set predecessor submenu
        if (menuItem.action === 'dep-submenu') {
          return (
            <SubmenuTrigger
              key={i}
              menuItem={menuItem}
              active={activeSubmenu === 'dep'}
              onEnter={() => openSubmenu('dep')}
            >
              {sameProjTasks.slice(0, 20).map((dep) => {
                const isLinked = currentDeps.includes(dep.id);
                return (
                  <SubmenuButton
                    key={dep.id}
                    onClick={() => {
                      onAction(isLinked ? `undep:${dep.id}` : `dep:${dep.id}`, task);
                      onClose();
                    }}
                    className={isLinked ? 'text-primary-fg font-medium' : 'text-fg-secondary'}
                  >
                    <span className="text-[10px] text-fg-faint w-4 text-center">{isLinked ? '✓' : ''}</span>
                    <span className="truncate">{dep.title}</span>
                  </SubmenuButton>
                );
              })}
            </SubmenuTrigger>
          );
        }

        // Reparent submenu (#1)
        if (menuItem.action === 'reparent-submenu') {
          return (
            <SubmenuTrigger
              key={i}
              menuItem={menuItem}
              active={activeSubmenu === 'reparent'}
              onEnter={() => openSubmenu('reparent')}
            >
              {potentialParents.slice(0, 20).map((p) => (
                <SubmenuButton
                  key={p.id}
                  onClick={() => {
                    onAction(`reparent:${p.id}`, task);
                    onClose();
                  }}
                >
                  <span className="truncate">{p.title}</span>
                </SubmenuButton>
              ))}
            </SubmenuTrigger>
          );
        }

        return (
          <button
            key={i}
            onClick={() => {
              onAction(menuItem.action, task);
              onClose();
            }}
            onMouseEnter={() => setActiveSubmenu(null)}
            className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-surface-sunken ${
              menuItem.danger ? 'text-danger hover:bg-danger-subtle' : 'text-fg-secondary'
            }`}
          >
            {menuItem.icon && <menuItem.icon size={12} />}
            {menuItem.label}
          </button>
        );
      })}
    </div>
  );
}

// ─── Submenu Helpers ─────────────────────────────────────

function SubmenuTrigger({
  menuItem,
  active,
  onEnter,
  children,
}: {
  menuItem: { label: string; icon?: any };
  active: boolean;
  onEnter: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative">
      <button
        className="w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-surface-sunken text-fg-secondary"
        onMouseEnter={onEnter}
      >
        {menuItem.icon && <menuItem.icon size={12} />}
        {menuItem.label}
        <ChevronRight size={10} className="ml-auto text-fg-faint" />
      </button>
      {active && (
        <div className="absolute left-full top-0 bg-surface-raised rounded-lg shadow-xl border border-edge py-1 min-w-[180px] max-h-[240px] overflow-y-auto">
          {children}
        </div>
      )}
    </div>
  );
}

function SubmenuButton({
  onClick,
  className = 'text-fg-secondary',
  children,
}: {
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 hover:bg-surface-sunken ${className}`}
    >
      {children}
    </button>
  );
}
