/**
 * The peek overlay itself — one instance, mounted next to the other global
 * overlays in app.tsx.
 *
 * A right-hand Drawer rather than a centred dialog: "slide something out beside
 * what I was reading" is the shape of a glance, and it leaves the conversation
 * behind it visible. The detail screens inside assume they own a full-height
 * column (pinned header, only the tab body scrolls), so the body is given a
 * fixed-height flex container to fill.
 */

import React, { Suspense } from 'react';
import { entityUrl } from '@greenhouse/types/entity-links';
import { Drawer, ErrorBoundary, IconButton, Spinner } from '../ui';
import { ArrowLeft, ExternalLink, X } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { useEntityPeekStore } from '../../stores/entity-peek-store';
import { EntityPeekScope } from './context';
import { ENTITY_PEEK_META, renderEntityPeekBody } from './registry';

export function EntityPeekHost() {
  const t = useT();
  const stack = useEntityPeekStore((s) => s.stack);
  const back = useEntityPeekStore((s) => s.back);
  const close = useEntityPeekStore((s) => s.close);

  const entry = stack[stack.length - 1];
  const meta = entry ? ENTITY_PEEK_META[entry.ref.kind] : null;
  const Icon = meta?.icon;
  const body = entry ? renderEntityPeekBody(entry.ref) : null;

  const openFullPage = () => {
    if (!entry) return;
    close();
    window.location.hash = entityUrl(entry.ref);
  };

  return (
    <Drawer
      open={stack.length > 0}
      onClose={close}
      side="right"
      width="min(880px, 92vw)"
      ariaLabel={t('entityPeek.title')}
    >
      {entry && meta && (
        <div className="h-full min-h-0 flex flex-col">
          <div className="flex-shrink-0 flex items-center gap-2 border-b border-edge px-3 py-2">
            {stack.length > 1 && (
              <IconButton label={t('common.back')} onClick={back}>
                <ArrowLeft size={14} />
              </IconButton>
            )}
            {Icon && <Icon size={14} className="text-fg-muted flex-shrink-0" />}
            <span className="flex-1 truncate text-sm font-medium text-fg" title={entry.label || undefined}>
              {entry.label || t(meta.fallbackTitleKey)}
            </span>
            <IconButton label={t('entityPeek.openFullPage')} onClick={openFullPage}>
              <ExternalLink size={14} />
            </IconButton>
            <IconButton label={t('common.close')} onClick={close}>
              <X size={16} />
            </IconButton>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {/* A detail screen that throws must not take the whole app with it —
                the record may simply be gone, or the model may have invented it. */}
            <ErrorBoundary key={entityUrl(entry.ref)}>
              <Suspense
                fallback={
                  <div className="flex h-full items-center justify-center">
                    <Spinner className="h-5 w-5 text-fg-faint" />
                  </div>
                }
              >
                <EntityPeekScope>
                  {body ?? <div className="p-6 text-sm text-fg-muted">{t('entityPeek.noPreview')}</div>}
                </EntityPeekScope>
              </Suspense>
            </ErrorBoundary>
          </div>
        </div>
      )}
    </Drawer>
  );
}
