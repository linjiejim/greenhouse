/**
 * RichMarkdown — enhanced markdown renderer with custom block support.
 *
 * Parses markdown content into segments with the shared Rich Output registry
 * (@greenhouse/types/rich-output — the same validation the web and mobile
 * clients run), rendering:
 * - Plain markdown via the existing <Markdown> component
 * - The blocks this kit draws (chart, datatable, stats, cards, steps, confirm)
 *   via their components, each inside its own error boundary
 * - A block still being streamed as a stable placeholder
 * - Every other registered block (mermaid, html-preview, mission files) as its
 *   plain-Markdown stand-in: those messages can be opened here even though the
 *   extension never asks the model for them (it declares only what it draws —
 *   RICH_BLOCKS_DRAWN in ./blocks)
 *
 * Drop-in replacement for <Markdown> in chat/agent contexts.
 * Wiki/source detail pages should continue using <Markdown> directly.
 */

import React, { useCallback, useContext, useMemo, useRef } from 'react';
import { AppLinkOriginContext, Markdown } from './markdown';
import { DEFAULT_FLATTEN_NOTES, flattenSegment, parseSegments, type FlattenNotes, type Segment } from './blocks/index';
import { CardsBlock } from './blocks/cards-block';
import { ChartBlock } from './blocks/chart-block';
import { ConfirmBlock } from './blocks/confirm-block';
import { DataTableBlock } from './blocks/datatable-block';
import { StatsBlock } from './blocks/stats-block';
import { StepsBlock, type StepsCopy } from './blocks/steps-block';
import { ErrorBoundary, Skeleton } from './ui';
import { useT } from '../lib/i18n';

// ─── Props ───────────────────────────────────────────────

interface RichMarkdownProps {
  content: string;
  className?: string;
  /** Use compact (tight) variant for chat/agent messages. */
  compact?: boolean;
  /**
   * A block button was pressed (confirm, stats, cards, steps): send its value as
   * the member's next message. Without it the buttons render disabled.
   */
  onBlockAction?: (value: string) => void | Promise<void>;
  /** The member's next message — restores which button was pressed after a reload. */
  resolvedActionValue?: string;
}

// ─── Component ───────────────────────────────────────────

export function RichMarkdown({
  content,
  className = '',
  compact,
  onBlockAction,
  resolvedActionValue,
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
      return JSON.stringify(seg) === JSON.stringify(prevSeg) ? prevSeg : seg;
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
        <MemoSegmentRenderer
          key={i}
          segment={segment}
          compact={compact}
          onBlockAction={onBlockAction}
          resolvedActionValue={resolvedActionValue}
        />
      ))}
    </div>
  );
}

// ─── Segment Renderer (memoized to skip re-renders when segment ref is stable) ─

const MemoSegmentRenderer = React.memo(function SegmentRenderer({
  segment,
  compact,
  onBlockAction,
  resolvedActionValue,
}: {
  segment: Segment;
  compact?: boolean;
  onBlockAction?: (value: string) => void | Promise<void>;
  resolvedActionValue?: string;
}) {
  const notes = useFallbackNotes();
  const stepsCopy = useStepsCopy();
  const openUrl = useOpenUrl();

  switch (segment.type) {
    case 'markdown':
      return <Markdown content={segment.content} compact={compact} />;

    case 'pending':
      return <PendingBlock />;

    case 'chart':
      return (
        <BlockBoundary>
          <ChartBlock data={segment.data} />
        </BlockBoundary>
      );

    case 'confirm':
      return (
        <BlockBoundary>
          <ConfirmBlock data={segment.data} onAction={onBlockAction} resolvedValue={resolvedActionValue} />
        </BlockBoundary>
      );

    case 'datatable':
      return (
        <BlockBoundary>
          <DataTableBlock data={segment.data} />
        </BlockBoundary>
      );

    case 'stats':
      return (
        <BlockBoundary>
          <StatsBlock
            data={segment.data}
            compact={compact}
            onAction={onBlockAction}
            resolvedValue={resolvedActionValue}
          />
        </BlockBoundary>
      );

    case 'cards':
      return (
        <BlockBoundary>
          <CardsBlock
            data={segment.data}
            compact={compact}
            onAction={onBlockAction}
            resolvedValue={resolvedActionValue}
            onOpenUrl={openUrl}
          />
        </BlockBoundary>
      );

    case 'steps':
      return (
        <BlockBoundary>
          <StepsBlock
            data={segment.data}
            copy={stepsCopy}
            compact={compact}
            onAction={onBlockAction}
            resolvedValue={resolvedActionValue}
          />
        </BlockBoundary>
      );

    case 'attachments':
      // Turn INPUTS: they belong on the user's bubble, never in a reply.
      return null;

    // Registered blocks this kit does not draw: show what they say.
    case 'mermaid':
    case 'html-preview':
    case 'mission-artifacts':
      return <Markdown content={flattenSegment(segment, notes)} compact={compact} />;

    default: {
      const unhandled: never = segment;
      return unhandled;
    }
  }
});

/** Stand-ins for what this kit cannot draw: diagrams keep their source, pages point to the web app. */
function useFallbackNotes(): FlattenNotes {
  const t = useT();
  return useMemo(
    () => ({
      ...DEFAULT_FLATTEN_NOTES,
      preview: (segment) =>
        `> ${segment.title ? t('richBlocks.previewElsewhere', { title: segment.title }) : t('richBlocks.previewElsewhereUntitled')}`,
      artifactsHeading: t('richBlocks.filesHeading'),
      attachmentsHeading: t('richBlocks.filesHeading'),
      stepStatus: (status) => t(`richBlocks.step${status[0]!.toUpperCase()}${status.slice(1)}`),
    }),
    [t],
  );
}

function useStepsCopy(): StepsCopy {
  const t = useT();
  return useMemo(
    () => ({
      status: {
        done: t('richBlocks.stepDone'),
        active: t('richBlocks.stepActive'),
        pending: t('richBlocks.stepPending'),
        blocked: t('richBlocks.stepBlocked'),
        skipped: t('richBlocks.stepSkipped'),
      },
    }),
    [t],
  );
}

/**
 * Cards open outside this host: an in-app `#/…` link in the web app of the
 * station (AppLinkOriginContext), an http(s) link as itself — always a new tab.
 */
function useOpenUrl(): (url: string) => void {
  const appOrigin = useContext(AppLinkOriginContext);
  return useCallback(
    (url: string) => {
      const target = url.startsWith('#/') ? (appOrigin ? `${appOrigin.replace(/\/+$/, '')}/${url}` : null) : url;
      if (target) window.open(target, '_blank', 'noopener,noreferrer');
    },
    [appOrigin],
  );
}

/** A block the model is still writing: reserve stable space instead of streaming its raw payload. */
function PendingBlock() {
  const t = useT();
  return (
    <div className="my-3 rounded-lg border border-edge bg-surface-sunken p-3" role="status">
      <div className="mb-2 text-xs text-fg-muted">{t('richBlocks.pending')}</div>
      <Skeleton className="h-16 w-full" />
    </div>
  );
}

/**
 * Blocks render model-authored data; a throw must cost only that block, never
 * the whole conversation (the shared parser rejects the shapes we know about —
 * this contains the ones we don't).
 */
function BlockBoundary({ children }: { children: React.ReactNode }) {
  const t = useT();
  return (
    <ErrorBoundary
      fallback={
        <div className="my-2 rounded-md border border-edge bg-surface-muted px-3 py-2 text-xs text-fg-muted">
          {t('richBlocks.renderFailed')}
        </div>
      }
    >
      {children}
    </ErrorBoundary>
  );
}
