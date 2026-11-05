/**
 * Dialog and Drawer for plugin pages. Both join the page's layer stack (one Escape closes one layer,
 * only the lowest modal layer dims), keep Tab inside, return focus on close, and ask before
 * dropping unsaved input (`dirty`). Irreversible confirms are not drawn here: call `confirm()`,
 * which the host draws over the whole app.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { confirm } from './embed.js';
import { useLayer } from './layers.js';
import { useKitStrings } from './strings.js';
import { CloseIcon, IconButton, cx } from './controls.js';

/** The host's fixed dialog sizes (apps/client/DESIGN.md Surfaces): the box never resizes. */
const DIALOG = {
  sm: 'w-[420px]',
  md: 'w-[560px] h-[600px]',
  lg: 'w-[760px] h-[640px]',
  xl: 'w-[960px] h-[680px]',
} as const;
const DRAWER = { sm: 'w-[400px]', md: 'w-[560px]', lg: 'w-[min(60vw,960px)]' } as const;

function useNarrow(width: number) {
  const [narrow, setNarrow] = useState(() => window.innerWidth < width);
  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < width);
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [width]);
  return narrow;
}

/** Close unless there is unsaved input the member wants to keep. */
function useGuardedClose(onClose: () => void, dirty: boolean | undefined) {
  const s = useKitStrings();
  const asking = useRef(false);
  return async () => {
    if (!dirty) return onClose();
    if (asking.current) return;
    asking.current = true;
    const discard = await confirm({
      title: s.discardTitle,
      confirmLabel: s.discard,
      cancelLabel: s.keepEditing,
      tone: 'danger',
    }).finally(() => (asking.current = false));
    if (discard) onClose();
  };
}

function useFirstFocus(panel: React.RefObject<HTMLDivElement | null>, into: 'field' | 'panel') {
  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    // a layer opened together with one above it leaves the focus to the top one
    const holder = document.activeElement?.closest('[role="dialog"]');
    if (holder && holder !== root) return;
    const field =
      into === 'field'
        ? (root.querySelector<HTMLElement>('[autofocus],input:not([type=hidden]):not(:disabled),textarea,select') ??
          null)
        : root.querySelector<HTMLElement>('[autofocus]');
    (field ?? root).focus();
  }, [panel, into]);
}

function Header({
  title,
  meta,
  actions,
  onClose,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
}) {
  const s = useKitStrings();
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-title-sm font-semibold text-foreground">{title}</h2>
        {meta ? <div className="truncate text-caption text-muted-foreground">{meta}</div> : null}
      </div>
      {actions}
      <IconButton label={s.close} onClick={onClose}>
        <CloseIcon size={18} />
      </IconButton>
    </div>
  );
}

/**
 * A short task that is not a list object (rename, invite, batch details). Fixed size on wide
 * screens; below 640 it rises from the bottom. Footer: secondary left, the primary rightmost.
 */
export function Dialog({
  title,
  size = 'md',
  onClose,
  footer,
  dirty,
  children,
}: {
  title: ReactNode;
  size?: keyof typeof DIALOG;
  onClose: () => void;
  footer?: ReactNode;
  dirty?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(640);
  const close = useGuardedClose(onClose, dirty);
  const { scrim } = useLayer({ modal: true, onEscape: () => void close(), root: () => panel.current });
  useFirstFocus(panel, 'field');
  return (
    <div
      className={cx(
        'fixed inset-0 z-40 flex justify-center',
        narrow ? 'items-end' : 'items-center',
        scrim && 'bg-scrim animate-fade-in',
      )}
      onMouseDown={(e) => e.target === e.currentTarget && void close()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cx(
          'flex flex-col overflow-hidden bg-popover text-foreground shadow-overlay outline-none',
          narrow
            ? 'max-h-[92dvh] w-full rounded-t-sheet pb-[env(safe-area-inset-bottom)] animate-slide-in-up'
            : cx('max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] rounded-dialog animate-pop-in', DIALOG[size]),
        )}
      >
        <Header title={title} onClose={() => void close()} />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <div
            className={cx('flex shrink-0 gap-2 border-t border-border px-4 py-3', narrow ? '*:flex-1' : 'justify-end')}
          >
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A list object: view it, edit it in place, or create one, all in this panel (same layout; values
 * become editable). From the right; full width below 640. Header: title, one line of meta, at most
 * two icon actions, ✕.
 */
export function Drawer({
  title,
  meta,
  actions,
  size = 'md',
  onClose,
  footer,
  dirty,
  children,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
  size?: keyof typeof DRAWER;
  onClose: () => void;
  footer?: ReactNode;
  dirty?: boolean;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const narrow = useNarrow(640);
  const close = useGuardedClose(onClose, dirty);
  const { scrim } = useLayer({ modal: true, onEscape: () => void close(), root: () => panel.current });
  useFirstFocus(panel, 'panel');
  return (
    <div
      className={cx('fixed inset-0 z-40 flex justify-end', scrim && 'bg-scrim animate-fade-in')}
      onMouseDown={(e) => e.target === e.currentTarget && void close()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={cx(
          'flex h-full flex-col border-l border-border bg-popover text-foreground shadow-overlay outline-none animate-slide-in-right',
          narrow ? 'w-full' : cx('max-w-[calc(100vw-48px)]', DRAWER[size]),
        )}
      >
        <Header title={title} meta={meta} actions={actions} onClose={() => void close()} />
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? (
          <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3 pb-[max(12px,env(safe-area-inset-bottom))]">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Label / value rows for a Drawer; `editing` swaps values for controls in the same place. */
export function DetailList({
  rows,
  editing,
}: {
  rows: { label: string; value: ReactNode; edit?: ReactNode; required?: boolean; error?: string }[];
  editing?: boolean;
}) {
  return (
    <dl className="grid grid-cols-[minmax(72px,max-content)_1fr] gap-x-6">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="flex min-h-8 items-start pt-1.5 text-body text-muted-foreground">
            {row.label}
            {editing && row.required ? <span className="ml-0.5 text-destructive">*</span> : null}
          </dt>
          <dd className="flex min-h-8 min-w-0 flex-col justify-center gap-1 py-0.5 text-body text-foreground select-text">
            {editing && row.edit ? row.edit : row.value}
            {editing && row.error ? <span className="text-caption text-destructive">{row.error}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
