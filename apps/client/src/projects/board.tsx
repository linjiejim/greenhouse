'use dom';
import React from 'react';
import { Avatar } from '../ui/avatar';
import { NativeMenu } from '../ui/menu.web';
import { localDay, dueBucket } from '../data/tasks';
import type { ProjectTask, TaskStatus } from '../shared/greenhouse-types';
const statuses: TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done'];
/** Same task tree/status API as classic; the DOM boundary receives only serializable state. */
export default function ProjectBoard({
  tasks,
  view,
  busy,
  labels,
  onOpen,
  onMove,
  onContext,
  selected,
}: {
  tasks: ProjectTask[];
  selected?: string;
  view: string;
  busy: boolean;
  labels: Record<string, string>;
  onOpen: (id: string) => void;
  onMove: (id: string, status: TaskStatus) => void;
  onContext: (id: string, x: number, y: number) => void;
  dom?: import('expo/dom').DOMProps;
}) {
  const row = (task: ProjectTask) => {
    const bucket = dueBucket(task.due_date, localDay(new Date()));
    const due = bucket === 'today' ? labels.today : task.due_date?.slice(5, 10).replace('-', '/');
    return (
      <>
        <button
          className="gh-board-task"
          aria-label={task.title}
          aria-pressed={selected === task.id}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const nodes = Array.from(
                e.currentTarget.closest('.gh-kanban')?.querySelectorAll<HTMLButtonElement>('.gh-board-task') ?? [],
              );
              nodes[
                (nodes.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1) + nodes.length) % nodes.length
              ]?.focus();
            }
          }}
          onClick={() => onOpen(task.id)}
        >
          <span className="gh-task-title">{task.title}</span>
          <span className="gh-task-meta">
            <span title={task.assignee_nickname || labels.unassigned}>
              <Avatar name={task.assignee_nickname || '?'} size={24} />
            </span>
            <span className="gh-task-priority" data-priority={task.priority}>
              {labels[task.priority]}
            </span>
            {due ? (
              <span className="gh-task-due" data-urgency={task.status !== 'done' ? bucket : 'later'}>
                {due}
              </span>
            ) : null}
          </span>
        </button>
        <div className="gh-task-menu">
          <NativeMenu
            title={labels.status}
            items={statuses.map((status) => ({
              id: status,
              title: labels[status],
              checked: task.status === status,
              disabled: busy,
            }))}
            onSelect={(status) => onMove(task.id, status as TaskStatus)}
          >
            <button aria-label={`${labels.status} ${task.title}`}>⋯</button>
          </NativeMenu>
        </div>
      </>
    );
  };
  if (view === 'gantt') {
    const starts = tasks.map((t) => Date.parse(t.start_date || t.due_date || t.created_at)).filter(Number.isFinite);
    const min = Math.min(...starts),
      max = Math.max(
        min + 86400000,
        ...tasks.map((t) => Date.parse(t.due_date || t.start_date || t.created_at)).filter(Number.isFinite),
      );
    return (
      <div className="gh-gantt" data-testid="project-gantt">
        {tasks.map((task) => {
          const start = Date.parse(task.start_date || task.due_date || task.created_at),
            end = Date.parse(task.due_date || task.start_date || task.created_at);
          return (
            <div
              key={task.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '220px 1fr',
                borderBottom: '1px solid var(--gh-line)',
                minHeight: 40,
              }}
            >
              <button className="gh-place-row" onClick={() => onOpen(task.id)}>
                {task.title}
              </button>
              <div style={{ position: 'relative', margin: 8, background: 'var(--gh-hover)' }}>
                <button
                  aria-label={task.title}
                  title={`${task.start_date ?? ''} → ${task.due_date ?? ''}`}
                  onClick={() => onOpen(task.id)}
                  style={{
                    position: 'absolute',
                    left: `${((start - min) / (max - min)) * 85}%`,
                    width: `${Math.max(4, ((end - start) / (max - min)) * 85)}%`,
                    height: 24,
                    background: 'var(--gh-focus)',
                    padding: 0,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <div className="gh-kanban" data-testid="project-kanban">
      {statuses.map((status) => (
        <section
          key={status}
          className="gh-kanban-column"
          aria-label={labels[status]}
          data-status={status}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            onMove(e.dataTransfer.getData('application/greenhouse-task'), status);
          }}
        >
          <h3>
            <span className="gh-status-dot" data-status={status} />
            {labels[status]}
            <span className="gh-column-count">{tasks.filter((task) => task.status === status).length}</span>
          </h3>
          {tasks
            .filter((task) => task.status === status)
            .map((task) => (
              <div
                key={task.id}
                className="gh-task-card"
                data-selected={selected === task.id}
                draggable={!busy}
                onDragStart={(e) => e.dataTransfer.setData('application/greenhouse-task', task.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onContext(task.id, e.clientX, e.clientY);
                }}
              >
                {row(task)}
              </div>
            ))}
        </section>
      ))}
    </div>
  );
}
