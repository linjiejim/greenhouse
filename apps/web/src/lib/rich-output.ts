/**
 * Web-side Rich Output glue: which blocks this screen can draw (sent as
 * `rich_blocks` on POST /api/chat) and the wording used when a block is turned
 * back into plain Markdown (copy as HTML, PDF export).
 *
 * Spec: docs/specs/20261008-rich-output-foundation.md §3 / §5, D11.
 */

import { useMemo } from 'react';
import { parseEntityUrl } from '@greenhouse/types/entity-links';
import {
  DEFAULT_FLATTEN_NOTES,
  MODEL_FENCES,
  type FlattenNotes,
  type RichCapability,
  type StepStatus,
} from '@greenhouse/types/rich-output';
import type { StepsCopy } from '@greenhouse/ui/components/blocks/steps-block';
import { openEntityPeek } from '../stores/entity-peek-store';
import { isSidePaneAvailable, openSidePane, useSidePaneStore } from '../stores/side-pane-store';
import { useT, type TranslationKey } from './i18n';

/**
 * The blocks the screen sending this turn can draw. Every model-authored block
 * has a web renderer (rich-markdown.tsx fails to compile otherwise); the one
 * exception is html-preview, which only opens where the Chat side pane is
 * mounted — the Assistant overlay elsewhere and the Bots page can only show its
 * source (HtmlPreviewBlock checks the same flag), so they do not ask for it.
 */
export function webRichBlocks(): RichCapability[] {
  const paneMounted = useSidePaneStore.getState().hostMounted;
  const blocks: RichCapability[] = MODEL_FENCES.filter((fence) => fence !== 'html-preview' || paneMounted);
  // The pane's preview can hand text back to the composer (side-pane/html-preview.tsx).
  if (paneMounted) blocks.push('html-preview-bridge');
  return blocks;
}

const STEP_STATUS_KEYS: Record<StepStatus, TranslationKey> = {
  done: 'richBlocks.stepDone',
  active: 'richBlocks.stepActive',
  pending: 'richBlocks.stepPending',
  blocked: 'richBlocks.stepBlocked',
  skipped: 'richBlocks.stepSkipped',
};

/** This app's words for the five step states (the shared StepsBlock holds no catalog). */
export function useStepsCopy(): StepsCopy {
  const t = useT();
  return useMemo(
    () => ({
      status: Object.fromEntries(Object.entries(STEP_STATUS_KEYS).map(([status, key]) => [status, t(key)])) as Record<
        StepStatus,
        string
      >,
    }),
    [t],
  );
}

/**
 * Open a `cards` item the way a Markdown link to it would open: a record
 * reference beside the conversation (Chat side pane) or as a peek elsewhere —
 * never navigating the reader away from the chat; any other link in a new tab.
 */
export function openCardUrl(url: string, label: string): void {
  const ref = parseEntityUrl(url);
  if (ref) {
    if (isSidePaneAvailable()) openSidePane({ kind: 'entity', ref, label });
    else openEntityPeek({ ref, label });
    return;
  }
  const target = url.startsWith('#/') ? `${window.location.pathname}${window.location.search}${url}` : url;
  window.open(target, '_blank', 'noopener,noreferrer');
}

/** How copy-as-HTML and PDF export word what they cannot draw. */
export function useFlattenNotes(): FlattenNotes {
  const t = useT();
  return useMemo(
    () => ({
      ...DEFAULT_FLATTEN_NOTES,
      // A page can be 400k characters of source — say where it lives instead.
      preview: (segment) =>
        segment.title
          ? t('richBlocks.previewElsewhere', { title: segment.title })
          : t('richBlocks.previewElsewhereUntitled'),
      artifactsHeading: t('richBlocks.filesHeading'),
      attachmentsHeading: t('richBlocks.attachmentsHeading'),
      boolean: (value) => (value ? t('common.yes') : t('common.no')),
      stepStatus: (status) => t(STEP_STATUS_KEYS[status]),
    }),
    [t],
  );
}
