/**
 * 任务树组件 — List 视图的任务行，支持展开/折叠子任务。
 */

import React from 'react';
import { ChevronDown, ChevronRight, Calendar } from '../../lib/icons';
import { statusConfig, priorityColors } from './types';
import type { Task } from './types';

// ─── Status Icon ─────────────────────────────────────────

export function StatusIcon({ status, size = 14 }: { status: string; size?: number }) {
  const cfg = statusConfig[status] ?? statusConfig.todo;
  const Icon = cfg.icon;
  return <Icon size={size} className={cfg.color} />;
}

// ─── Task Tree Item ──────────────────────────────────────

export function TaskTreeItem({
  task,
  depth,
  onSelect,
  expanded,
  onToggle,
}: {
  task: Task;
  depth: number;
  onSelect: (t: Task) => void;
  expanded: Set<number>;
  onToggle: (id: number) => void;
}) {
  const hasChildren = task.children && task.children.length > 0;
  const isExpanded = expanded.has(task.id);
  const today = new Date().toISOString().split('T')[0];
  const isOverdue = task.due_date && task.due_date < today && task.status !== 'done' && task.status !== 'cancelled';

  return (
    <>
      <div
        className={`flex items-center gap-2 py-1.5 px-3 hover:bg-surface-sunken cursor-pointer border-b border-edge group ${isOverdue ? 'bg-danger-subtle/30' : ''}`}
        style={{ paddingLeft: `${12 + depth * 20}px` }}
        onClick={() => onSelect(task)}
      >
        {/* Expand toggle */}
        <span
          className={`w-4 h-4 flex items-center justify-center flex-shrink-0 ${hasChildren ? 'cursor-pointer hover:bg-surface-muted rounded' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggle(task.id);
          }}
        >
          {hasChildren &&
            (isExpanded ? (
              <ChevronDown size={12} className="text-fg-faint" />
            ) : (
              <ChevronRight size={12} className="text-fg-faint" />
            ))}
        </span>

        <StatusIcon status={task.status} />
        <span
          className={`flex-1 text-sm truncate ${task.status === 'done' ? 'line-through text-fg-faint' : 'text-fg'}`}
        >
          {task.title}
        </span>

        {task.priority !== 'normal' && (
          <span className={`text-[10px] font-medium ${priorityColors[task.priority]}`}>
            {task.priority === 'urgent' ? '🔴' : task.priority === 'high' ? '🟠' : '⚪'}
          </span>
        )}

        {task.assignee_nickname && (
          <span className="text-[10px] text-fg-faint bg-surface-muted px-1.5 py-0.5 rounded-full truncate max-w-[60px]">
            {task.assignee_nickname}
          </span>
        )}

        {task.due_date && (
          <span
            className={`text-[10px] flex items-center gap-0.5 ${isOverdue ? 'text-danger font-medium' : 'text-fg-faint'}`}
          >
            <Calendar size={10} />
            {task.due_date.slice(5)}
          </span>
        )}
      </div>
      {hasChildren &&
        isExpanded &&
        task.children!.map((child) => (
          <TaskTreeItem
            key={child.id}
            task={child}
            depth={depth + 1}
            onSelect={onSelect}
            expanded={expanded}
            onToggle={onToggle}
          />
        ))}
    </>
  );
}
