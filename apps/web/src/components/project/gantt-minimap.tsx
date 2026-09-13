/**
 * Mini-map overview for the Gantt chart timeline.
 * Shows a compressed view of all bars with a draggable viewport indicator.
 * Extracted from gantt-view.tsx.
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { Task } from './types';
import { useT } from '../../lib/i18n';

export function GanttMiniMap({
  flatTasks,
  totalDays,
  DAY_WIDTH,
  ROW_HEIGHT,
  timelineRef,
  getBarStyle,
}: {
  flatTasks: Array<Task & { depth: number; isParent: boolean }>;
  totalDays: number;
  DAY_WIDTH: number;
  ROW_HEIGHT: number;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  getBarStyle: (t: Task & { isParent: boolean }, drag: any) => any;
}) {
  const t = useT();
  const miniRef = useRef<HTMLDivElement>(null);
  const timelineWidth = totalDays * DAY_WIDTH;
  const contentHeight = flatTasks.length * ROW_HEIGHT;
  const MINI_HEIGHT = 32;
  const [viewState, setViewState] = useState({ left: 0, width: 0, containerWidth: 0, fullyVisible: false });

  // Calculate scale
  const containerWidth = viewState.containerWidth || 300;
  const scaleX = containerWidth / Math.max(timelineWidth, 1);
  const scaleY = MINI_HEIGHT / Math.max(contentHeight, 1);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const updateView = () => {
      const cw = miniRef.current?.clientWidth ?? el.clientWidth;
      const sx = cw / Math.max(totalDays * DAY_WIDTH, 1);
      setViewState({
        left: el.scrollLeft * sx,
        width: Math.min(el.clientWidth * sx, cw),
        containerWidth: cw,
        fullyVisible: el.scrollWidth <= el.clientWidth + 1,
      });
    };
    updateView();
    el.addEventListener('scroll', updateView);
    window.addEventListener('resize', updateView);
    return () => {
      el.removeEventListener('scroll', updateView);
      window.removeEventListener('resize', updateView);
    };
  }, [totalDays, DAY_WIDTH, timelineRef]);

  const moveViewport = useCallback(
    (clientX: number) => {
      const timeline = timelineRef.current;
      const mini = miniRef.current;
      if (!timeline || !mini) return;
      const rect = mini.getBoundingClientRect();
      const x = clientX - rect.left;
      const cw = mini.clientWidth;
      const ratio = x / cw;
      timeline.scrollLeft = ratio * timelineWidth - timeline.clientWidth / 2;
    },
    [timelineWidth, timelineRef],
  );

  if (viewState.fullyVisible) return null;

  const timeline = timelineRef.current;
  const maxScroll = Math.max(0, (timeline?.scrollWidth ?? timelineWidth) - (timeline?.clientWidth ?? 0));

  return (
    <div
      ref={miniRef}
      role="scrollbar"
      tabIndex={0}
      aria-label={t('task.timelineOverview')}
      aria-orientation="horizontal"
      aria-valuemin={0}
      aria-valuemax={Math.round(maxScroll)}
      aria-valuenow={Math.round(timeline?.scrollLeft ?? 0)}
      className="relative bg-surface-sunken border-t border-edge cursor-pointer touch-none select-none flex-shrink-0 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-primary-500/50"
      style={{ height: MINI_HEIGHT }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        moveViewport(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) moveViewport(event.clientX);
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          event.currentTarget.releasePointerCapture(event.pointerId);
        }
      }}
      onKeyDown={(event) => {
        const el = timelineRef.current;
        if (!el) return;
        const step = Math.max(80, el.clientWidth * 0.15);
        if (event.key === 'ArrowLeft') el.scrollLeft -= step;
        else if (event.key === 'ArrowRight') el.scrollLeft += step;
        else if (event.key === 'Home') el.scrollLeft = 0;
        else if (event.key === 'End') el.scrollLeft = el.scrollWidth;
        else return;
        event.preventDefault();
      }}
    >
      {/* Mini bars */}
      {flatTasks.map((t, idx) => {
        const bar = getBarStyle(t, null);
        if (!bar || t.task_type === 'milestone') return null;
        return (
          <div
            key={t.id}
            className={`absolute ${bar.bgColor} opacity-50`}
            style={{
              left: bar.left * scaleX,
              top: idx * ROW_HEIGHT * scaleY,
              width: Math.max(bar.width * scaleX, 1),
              height: Math.max(ROW_HEIGHT * scaleY - 1, 1),
            }}
          />
        );
      })}
      {/* Viewport indicator */}
      <div
        className="absolute top-0 bottom-0 border-2 border-primary-500 bg-primary-500/10 rounded-sm pointer-events-none flex items-center justify-center"
        style={{ left: viewState.left, width: Math.max(viewState.width, 4) }}
      >
        {viewState.width >= 24 && <span className="h-3 w-1 rounded-full bg-primary-500/50" />}
      </div>
    </div>
  );
}
