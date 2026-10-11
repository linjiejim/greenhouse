/**
 * The frame every card sits in, whatever draws inside it and whoever hosts it:
 * a titled panel with an optional actions slot and drag handle, and a body that
 * scrolls on its own. Tables dashboards put a `TableCardView` in it; app pages
 * (Phase 1, slice R) also put records, kanban, calendar, gallery, form and
 * button cards in it — so one grid of mixed cards still reads as one surface.
 */

import type { ReactNode } from 'react';
import { WIDGET_DRAG_HANDLE_CLASS } from '../workbench/widget-grid';

export interface TableCardFrameProps {
  title: string;
  /** Host actions in the title row (edit / delete on a dashboard, card-face actions in an app). */
  actions?: ReactNode;
  /** Make the title row the grid's drag handle (the dashboard while a builder arranges it). */
  draggable?: boolean;
  /** `data-testid` of the frame. */
  testId?: string;
  children: ReactNode;
}

export function TableCardFrame({ title, actions, draggable = false, testId, children }: TableCardFrameProps) {
  return (
    <section
      className="flex h-full min-w-0 flex-col overflow-hidden rounded-xl border border-edge bg-surface-card p-4 shadow-sm"
      data-testid={testId}
    >
      <div
        className={`mb-3 flex flex-shrink-0 items-center justify-between gap-2 ${
          draggable ? `${WIDGET_DRAG_HANDLE_CLASS} cursor-move` : ''
        }`}
      >
        <h3 className="truncate text-sm font-semibold text-fg" title={title}>
          {title}
        </h3>
        {actions && <div className="flex">{actions}</div>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}
