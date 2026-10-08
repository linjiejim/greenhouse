/**
 * Web-side Rich Output glue: which blocks this screen can draw (sent as
 * `rich_blocks` on POST /api/chat) and the wording used when a block is turned
 * back into plain Markdown (copy as HTML, PDF export).
 *
 * Spec: docs/specs/20261008-rich-output-foundation.md §3 / §5, D11.
 */

import { useMemo } from 'react';
import { DEFAULT_FLATTEN_NOTES, MODEL_FENCES, type FlattenNotes, type ModelFence } from '@greenhouse/types/rich-output';
import { useSidePaneStore } from '../stores/side-pane-store';
import { useT } from './i18n';

/**
 * The blocks the screen sending this turn can draw. Every model-authored block
 * has a web renderer (rich-markdown.tsx fails to compile otherwise); the one
 * exception is html-preview, which only opens where the Chat side pane is
 * mounted — the Assistant overlay elsewhere and the Bots page can only show its
 * source (HtmlPreviewBlock checks the same flag), so they do not ask for it.
 */
export function webRichBlocks(): ModelFence[] {
  const paneMounted = useSidePaneStore.getState().hostMounted;
  return MODEL_FENCES.filter((fence) => fence !== 'html-preview' || paneMounted);
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
    }),
    [t],
  );
}
