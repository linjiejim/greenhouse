/**
 * What each kind of side-pane entry looks like.
 *
 * The whole point of the pane is that adding a preview capability is adding a
 * case here plus a member on `SidePaneEntry` — call sites (a Markdown link, an
 * artifact card, a lightbox button) only ever say "open this".
 *
 * Records reuse the entity-peek registry rather than getting a second set of
 * detail components: a peek and a pane are two frames around one screen.
 */

import React, { lazy } from 'react';
import type { EntityRef } from '@greenhouse/types/entity-links';
import { Code, FileText, Pencil, type LucideIcon } from '../../lib/icons';
import type { TranslationKey } from '../../lib/i18n';
import type { SidePaneEntry } from '../../stores/side-pane-store';
import { entityPeekMeta, renderEntityPeekBody } from '../entity-peek/registry';

const HtmlPreview = lazy(() => import('./html-preview').then((m) => ({ default: m.HtmlPreview })));
const ImageAnnotator = lazy(() => import('./image-annotator').then((m) => ({ default: m.ImageAnnotator })));

export interface SidePaneChrome {
  icon: LucideIcon;
  /** Shown when the entry carries no label of its own. */
  fallbackTitleKey: TranslationKey;
  /** The entry's own title, when it has one. */
  title?: string;
}

export function sidePaneChrome(entry: SidePaneEntry): SidePaneChrome {
  switch (entry.kind) {
    case 'entity': {
      const meta = entityPeekMeta(entry.ref.kind);
      return { icon: meta.icon, fallbackTitleKey: meta.fallbackTitleKey, title: entry.label };
    }
    case 'html':
      return { icon: Code, fallbackTitleKey: 'sidePane.htmlPreview', title: entry.title };
    case 'pdf':
      return { icon: FileText, fallbackTitleKey: 'sidePane.document', title: entry.name };
    case 'image-annotate':
      return { icon: Pencil, fallbackTitleKey: 'annotate.title' };
  }
}

/** The pane body, or null when this kind has nothing to show. */
export function renderSidePaneBody(entry: SidePaneEntry): React.ReactNode | null {
  switch (entry.kind) {
    case 'entity':
      return renderEntityPeekBody(entry.ref as EntityRef);
    case 'html':
      return <HtmlPreview code={entry.code} title={entry.title} />;
    case 'pdf':
      // Same authenticated-URL iframe the media dialog uses; a PDF is inert
      // markup to the browser's own viewer, not a script surface.
      return <iframe src={entry.url} title={entry.name} className="h-full w-full border-0 bg-white" />;
    case 'image-annotate':
      return <ImageAnnotator src={entry.src} imageId={entry.imageId} />;
  }
}
