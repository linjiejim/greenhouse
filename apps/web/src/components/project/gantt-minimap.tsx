/**
 * Mini-map overview for the Gantt chart timeline.
 * Shows a compressed view of all bars with a draggable viewport indicator.
 * Extracted from gantt-view.tsx.
 */

import React, { useRef, useState, useEffect, useCallback } from 'react';
import type { Task } from './types';

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
  const miniRef = useRef<HTMLDivElement>(null);
  const timelineWidth = totalDays * DAY_WIDTH;
  const contentHeight = flatTasks.length * ROW_HEIGHT;
  const MINI_HEIGHT = 32;
  const [viewState, setViewState] = useState({ left: 0, width: 100 });

  // Calculate scale
  const containerWidth = miniRef.current?.clientWidth ?? 300;
  const scaleX = containerWidth / timelineWidth;
  const scaleY = MINI_HEIGHT / Math.max(contentHeight, 1);

  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const updateView = () => {
      const cw = miniRef.current?.clientWidth ?? 300;
      const sx = cw / (totalDays * DAY_WIDTH);
      setViewState({
        left: el.scrollLeft * sx,
        width: Math.min(el.clientWidth * sx, cw),
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

  const handleMiniClick = useCallback(
    (e: React.MouseEvent) => {
      if (!timelineRef.current || !miniRef.current) return;
      const rect = miniRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const cw = miniRef.current.clientWidth;
      const ratio = x / cw;
      timelineRef.current.scrollLeft = ratio * timelineWidth - timelineRef.current.clientWidth / 2;
    },
    [timelineWidth, timelineRef],
  );

  const handleMiniDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const onMove = (ev: MouseEvent) => {
        if (!timelineRef.current || !miniRef.current) return;
        const rect = miniRef.current.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const cw = miniRef.current.clientWidth;
        const ratio = x / cw;
        timelineRef.current.scrollLeft = ratio * timelineWidth - timelineRef.current.clientWidth / 2;
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    },
    [timelineWidth, timelineRef],
  );

  return (
    <div
      ref={miniRef}
      className="relative bg-surface-sunken border-t border-edge cursor-pointer select-none flex-shrink-0"
      style={{ height: MINI_HEIGHT }}
      onClick={handleMiniClick}
      onMouseDown={handleMiniDrag}
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
        className="absolute top-0 bottom-0 border-2 border-primary-500 bg-primary-500/10 rounded-sm pointer-events-none"
        style={{ left: viewState.left, width: Math.max(viewState.width, 4) }}
      />
    </div>
  );
}
