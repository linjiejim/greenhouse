/**
 * 看板列组件 — Board 视图中的单列，按状态分组展示任务卡片。
 */

import React from 'react';
import { StatusIcon } from './task-tree';
import { statusConfig, priorityColors } from './types';
import type { Task } from './types';

export function BoardColumn({
  status,
  tasks,
  onSelect,
  onStatusChange: _onStatusChange,
}: {
  status: string;
  tasks: Task[];
  onSelect: (t: Task) => void;
  onStatusChange: (taskId: number, status: string) => void;
}) {
  const cfg = statusConfig[status] ?? statusConfig.todo;
  const flatTasks = tasks.filter((t) => t.status === status);

  return (
    <div className="w-full md:flex-1 md:min-w-[220px] md:max-w-[320px]">
      <div className={`flex items-center gap-2 px-3 py-2 rounded-t-lg border ${cfg.bg}`}>
        <StatusIcon status={status} size={13} />
        <span className="text-xs font-medium">{cfg.label}</span>
        <span className="text-[10px] text-fg-faint ml-auto">{flatTasks.length}</span>
      </div>
      <div className="space-y-1.5 p-1.5 bg-surface-sunken/50 rounded-b-lg border border-t-0 border-edge min-h-[100px]">
        {flatTasks.map((t) => (
          <div
            key={t.id}
            onClick={() => onSelect(t)}
            className="bg-surface-raised rounded-lg border border-edge p-2.5 cursor-pointer hover:border-primary-300 hover:shadow-sm transition-all text-xs"
          >
            <p className="text-fg font-medium mb-1.5 line-clamp-2">{t.title}</p>
            <div className="flex items-center justify-between text-fg-faint">
              <div className="flex items-center gap-2">
                {t.priority !== 'normal' && (
                  <span className={`font-medium ${priorityColors[t.priority]}`}>{t.priority}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5">
                {t.assignee_nickname && (
                  <span className="bg-surface-muted px-1.5 py-0.5 rounded-full text-[10px] truncate max-w-[50px]">
                    {t.assignee_nickname}
                  </span>
                )}
                {t.due_date && <span className="text-[10px]">{t.due_date.slice(5)}</span>}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
