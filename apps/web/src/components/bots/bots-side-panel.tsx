/**
 * Right-hand column of the Bots page (conversation info). In the document
 * flow beside the conversation on wide screens — so the member keeps talking
 * while it is open, like Chat's side pane — and a full-screen sheet below
 * `lg`, where there is no second column to give.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { IconButton } from '../ui';
import { X } from '../../lib/icons';
import { useT } from '../../lib/i18n';

const SPLIT_MIN_VIEWPORT = 1024;

/** Wide enough for a second column beside the conversation (Tailwind `lg`). */
export function useSplitCapable(): boolean {
  const [capable, setCapable] = useState(
    () => typeof window === 'undefined' || window.innerWidth >= SPLIT_MIN_VIEWPORT,
  );
  useEffect(() => {
    const query = window.matchMedia(`(min-width: ${SPLIT_MIN_VIEWPORT}px)`);
    const sync = () => setCapable(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);
  return capable;
}

export function BotsSidePanel({
  title,
  onClose,
  children,
  testId,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  testId?: string;
}) {
  const t = useT();
  const split = useSplitCapable();

  useEffect(() => {
    if (split) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose, split]);

  const header = (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
      <span className="flex-1 truncate text-sm font-semibold text-fg">{title}</span>
      <IconButton label={t('common.close')} onClick={onClose} size="compact">
        <X size={16} />
      </IconButton>
    </div>
  );
  const body = <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>;

  if (!split) {
    return (
      <div
        className="fixed inset-0 z-40 flex flex-col bg-surface-canvas safe-area-panel"
        role="dialog"
        aria-label={title}
        data-testid={testId}
      >
        {header}
        {body}
      </div>
    );
  }
  return (
    <aside
      className="flex h-full w-[22rem] flex-shrink-0 flex-col border-l border-edge bg-surface-raised"
      aria-label={title}
      data-testid={testId}
    >
      {header}
      {body}
    </aside>
  );
}

/** A titled block inside the panel. */
export function PanelSection({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-b border-edge px-4 py-4 last:border-b-0">
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-fg-muted">{title}</h3>
          {hint && <p className="mt-0.5 text-[11px] leading-4 text-fg-faint">{hint}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
