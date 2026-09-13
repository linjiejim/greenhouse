/**
 * RichMarkdown — enhanced markdown renderer with custom block support.
 *
 * Parses markdown content into segments, rendering:
 * - Plain markdown via the existing <Markdown> component
 * - Custom blocks (chart, confirm, datatable) via specialized React components
 *
 * Drop-in replacement for <Markdown> in chat/agent contexts.
 * Wiki/source detail pages should continue using <Markdown> directly.
 */

import React, { useMemo, useRef } from 'react';
import { Markdown } from './markdown';
import { parseSegments } from './blocks/index';
import type {
  Segment,
  MarkdownSegment,
  MermaidSegment,
  HtmlPreviewSegment,
  ChartData,
  ConfirmData,
  DataTableData,
  MissionArtifactsData,
} from './blocks/index';
import { ChartBlock } from './blocks/chart-block';
import { ConfirmBlock } from './blocks/confirm-block';
import { DataTableBlock, DataTablePendingBlock } from './blocks/datatable-block';
import { HtmlPreviewBlock } from './blocks/html-preview-block';
import { MermaidBlock } from './blocks/mermaid-block';
import { MissionArtifactsBlock } from './blocks/mission-artifacts-block';
import { ErrorBoundary } from './ui';
import { useT } from '../lib/i18n';
import type { MarkdownLinkTarget } from './markdown';

// ─── Props ───────────────────────────────────────────────

interface RichMarkdownProps {
  content: string;
  className?: string;
  /** Use compact (tight) variant for chat/agent messages. */
  compact?: boolean;
  /** Callback for confirm block actions. If not provided, confirm buttons are rendered but disabled. */
  onConfirmAction?: (value: string) => void;
  /** Persisted follow-up user message used to restore confirm selection after reload. */
  resolvedConfirmValue?: string;
  /** Where ordinary navigating links go; forwarded to <Markdown>. */
  linkTarget?: MarkdownLinkTarget;
}

// ─── Component ───────────────────────────────────────────

export function RichMarkdown({
  content,
  className = '',
  compact,
  onConfirmAction,
  resolvedConfirmValue,
  linkTarget,
}: RichMarkdownProps) {
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
      if (seg.type === 'datatable-pending') return prevSeg;
      if (seg.type === 'mermaid' || seg.type === 'html-preview') {
        // These two carry `code`, not `data`. Falling through to the generic
        // compare below would read `undefined` on both sides and call every
        // block identical to the last one — an edited diagram or page would
        // never re-render.
        return seg.code === (prevSeg as MermaidSegment | HtmlPreviewSegment).code ? prevSeg : seg;
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

  return (
    <div className={`rich-markdown ${compact ? 'rich-markdown-compact' : 'rich-markdown-base'} ${className}`}>
      {segments.map((segment, i) => (
        <MemoSegmentRenderer
          key={i}
          segment={segment}
          compact={compact}
          onConfirmAction={onConfirmAction}
          resolvedConfirmValue={resolvedConfirmValue}
          linkTarget={linkTarget}
        />
      ))}
    </div>
  );
}

// ─── Segment Renderer (memoized to skip re-renders when segment ref is stable) ─

const MemoSegmentRenderer = React.memo(function SegmentRenderer({
  segment,
  compact,
  onConfirmAction,
  resolvedConfirmValue,
  linkTarget,
}: {
  segment: Segment;
  compact?: boolean;
  onConfirmAction?: (value: string) => void;
  resolvedConfirmValue?: string;
  linkTarget?: MarkdownLinkTarget;
}) {
  switch (segment.type) {
    case 'markdown':
      return <Markdown content={segment.content} compact={compact} linkTarget={linkTarget} />;

    case 'chart':
      return (
        <BlockBoundary>
          <ChartBlock data={segment.data as ChartData} compact={compact} />
        </BlockBoundary>
      );

    case 'confirm':
      return (
        <BlockBoundary>
          <ConfirmBlock
            data={segment.data as ConfirmData}
            compact={compact}
            onAction={onConfirmAction}
            resolvedValue={resolvedConfirmValue}
          />
        </BlockBoundary>
      );

    case 'datatable':
      return (
        <BlockBoundary>
          <DataTableBlock data={segment.data as DataTableData} compact={compact} />
        </BlockBoundary>
      );

    case 'datatable-pending':
      return <DataTablePendingBlock compact={compact} />;

    case 'mermaid':
      return (
        <BlockBoundary>
          <MermaidBlock code={segment.code} compact={compact} />
        </BlockBoundary>
      );

    case 'html-preview':
      return (
        <BlockBoundary>
          <HtmlPreviewBlock code={segment.code} title={segment.title} compact={compact} />
        </BlockBoundary>
      );

    case 'mission-artifacts':
      return (
        <BlockBoundary>
          <MissionArtifactsBlock data={segment.data as MissionArtifactsData} />
        </BlockBoundary>
      );

    default:
      return null;
  }
});

// ─── Per-block boundary ──────────────────────────────────

/**
 * Blocks render model-authored data, and a throw here would otherwise unmount
 * the whole conversation — that is how one rowless datatable made a session
 * impossible to open. parseSegments rejects the shapes we know about; this
 * contains the ones we don't.
 */
function BlockBoundary({ children }: { children: React.ReactNode }) {
  const t = useT();

  return (
    <ErrorBoundary
      fallback={
        <div className="my-2 rounded-md border border-edge bg-surface-muted px-3 py-2 text-xs text-fg-muted">
          {t('common.blockRenderFailed')}
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
