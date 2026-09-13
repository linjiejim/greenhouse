/**
 * The message-flow card for an ```html-preview fence.
 *
 * Deliberately NOT an inline iframe. A generated page assumes it owns a
 * viewport; squeezed into a chat column it is unreadable, and every re-render
 * of a long conversation would re-run someone else's scripts. So the message
 * gets a compact card, and the document itself opens in the side pane where it
 * has room and a single lifecycle.
 *
 * Where no pane host exists (the Assistant overlay), the card degrades to
 * source + download rather than pretending the button does something.
 */

import React, { useState } from 'react';
import { ChevronDown, ChevronRight, Code2, PanelRight } from 'lucide-react';
import { Button } from '../ui';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';
import { useT } from '../../lib/i18n';
import { openSidePane, useSidePaneStore } from '../../stores/side-pane-store';

export function HtmlPreviewBlock({
  code,
  title,
  compact = false,
}: {
  code: string;
  title?: string;
  compact?: boolean;
}) {
  const t = useT();
  const [sourceOpen, setSourceOpen] = useState(false);
  const hostMounted = useSidePaneStore((s) => s.hostMounted);

  return (
    <RichBlockShell
      compact={compact}
      header={
        <div className="flex items-center gap-2">
          <Code2 size={13} className="flex-shrink-0 text-fg-muted" />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-fg" title={title || undefined}>
            {title || t('sidePane.htmlPreview')}
          </span>
        </div>
      }
    >
      <div className={`${richBlockBodyClass(compact)} space-y-2`}>
        <div className="flex flex-wrap items-center gap-2">
          {hostMounted && (
            <Button size="sm" onClick={() => openSidePane({ kind: 'html', code, title })}>
              <PanelRight size={13} className="mr-1.5" />
              {t('sidePane.openPreview')}
            </Button>
          )}
          <button
            type="button"
            className="flex items-center gap-1 text-xs text-fg-muted hover:text-fg"
            onClick={() => setSourceOpen((v) => !v)}
          >
            {sourceOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            {t('sidePane.showSource')}
          </button>
        </div>
        {sourceOpen && (
          <pre className="hl-pre max-h-64 overflow-auto text-xs">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </RichBlockShell>
  );
}
