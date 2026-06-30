/**
 * RichMarkdown — enhanced markdown renderer with custom block support.
 *
 * Parses markdown content into segments, rendering:
 * - Plain markdown via the existing <Markdown> component
 * - Custom blocks (chart, confirm, datatable, local files) via specialized React components
 *
 * Drop-in replacement for <Markdown> in chat/agent contexts.
 * Wiki/source detail pages should continue using <Markdown> directly.
 */

import React, { useMemo, useRef } from 'react';
import { Markdown } from './markdown';
import { parseSegments } from './blocks/index';
import type { Segment, MarkdownSegment, ChartData, ConfirmData, DataTableData, LocalFilesData } from './blocks/index';
import { ChartBlock } from './blocks/chart-block';
import { ConfirmBlock } from './blocks/confirm-block';
import { DataTableBlock } from './blocks/datatable-block';
import { LocalFilesBlock } from './blocks/local-files-block';

// ─── Props ───────────────────────────────────────────────

interface RichMarkdownProps {
  content: string;
  className?: string;
  /** Use compact (tight) variant for chat/agent messages. */
  compact?: boolean;
  /** Callback for confirm block actions. If not provided, confirm buttons are rendered but disabled. */
  onConfirmAction?: (value: string) => void;
}

// ─── Component ───────────────────────────────────────────

export function RichMarkdown({ content, className = '', compact, onConfirmAction }: RichMarkdownProps) {
  const rawSegments = useMemo(() => parseSegments(content), [content]);

  // Stabilize segment references: reuse previous objects when content/data is unchanged.
  // During streaming, earlier segments (e.g. a completed chart) stay identical while only
  // the trailing markdown segment grows. Without stabilization, every segment gets a new
  // object reference on each render, causing chart/datatable components to destroy and
  // recreate themselves (flickering).
  const prevRef = useRef<Segment[]>([]);
  const segments = useMemo(() => {
    const prev = prevRef.current;
    const stable = rawSegments.map((seg, i) => {
      const prevSeg = prev[i];
      if (!prevSeg || prevSeg.type !== seg.type) return seg;
      if (seg.type === 'markdown') {
        return seg.content === (prevSeg as MarkdownSegment).content ? prevSeg : seg;
      }
      // For block types (chart, confirm, datatable), compare serialized data
      if (JSON.stringify((seg as { data: unknown }).data) === JSON.stringify((prevSeg as { data: unknown }).data)) {
        return prevSeg;
      }
      return seg;
    });
    prevRef.current = stable;
    return stable;
  }, [rawSegments]);

  // Fast path: if only one markdown segment, use the original Markdown component directly
  if (segments.length === 1 && segments[0].type === 'markdown') {
    return <Markdown content={segments[0].content} className={className} compact={compact} />;
  }

  return (
    <div className={className}>
      {segments.map((segment, i) => (
        <MemoSegmentRenderer key={i} segment={segment} compact={compact} onConfirmAction={onConfirmAction} />
      ))}
    </div>
  );
}

// ─── Segment Renderer (memoized to skip re-renders when segment ref is stable) ─

const MemoSegmentRenderer = React.memo(function SegmentRenderer({
  segment,
  compact,
  onConfirmAction,
}: {
  segment: Segment;
  compact?: boolean;
  onConfirmAction?: (value: string) => void;
}) {
  switch (segment.type) {
    case 'markdown':
      return <Markdown content={segment.content} compact={compact} />;

    case 'chart':
      return <ChartBlock data={segment.data as ChartData} />;

    case 'confirm':
      return <ConfirmBlock data={segment.data as ConfirmData} onAction={onConfirmAction} />;

    case 'datatable':
      return <DataTableBlock data={segment.data as DataTableData} />;

    case 'local-files':
      return <LocalFilesBlock data={segment.data as LocalFilesData} />;

    default:
      return null;
  }
});
