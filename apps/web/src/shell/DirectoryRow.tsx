/**
 * A directory row (layout.md, 目录行): icon or avatar, the name, and at most one signal on the
 * right — needs-you count > muted > running > unread. Its right-click menu is the same list
 * as the object's own "⋯". Renaming happens in place.
 */

import {
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { BellOff, ChevronDown, ChevronRight } from 'lucide-react';
import { useContextMenu, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { cx } from '../lib/cx';
import { useT } from '../lib/i18n';

/** Extra handlers for a row: dragging, dropping and keys (merged with the right-click menu's). */
export type RowProps = Pick<
  HTMLAttributes<HTMLElement>,
  'draggable' | 'onDragStart' | 'onDragEnd' | 'onDragOver' | 'onDragLeave' | 'onDrop' | 'onKeyDown'
>;

export interface Signal {
  needs?: number;
  muted?: boolean;
  running?: boolean;
  unread?: boolean;
}

export function SignalMark({ signal }: { signal: Signal }) {
  const t = useT();
  if (signal.needs) return <span className="app-count is-warning">{signal.needs > 99 ? '99+' : signal.needs}</span>;
  if (signal.muted) return <BellOff size={icon.sm} className="app-row-muted" aria-label={t('row.muted')} />;
  if (signal.running) return <span className="app-running-dot" aria-label={t('row.running')} />;
  if (signal.unread) return <span className="app-unread-dot" aria-label={t('row.unreadDot')} />;
  return null;
}

export function DirectoryRow({
  leading,
  title,
  href,
  active = false,
  signal,
  count,
  indent = 0,
  expanded,
  leaf = false,
  variant,
  menu,
  menuLabel,
  renaming = false,
  onRename,
  onClick,
  rowProps,
  dropAt,
}: {
  leading?: ReactNode;
  title: string;
  /** A link row; rows without one are buttons. */
  href?: string;
  active?: boolean;
  signal?: Signal;
  /** A plain count (sections like 运行中). */
  count?: number;
  indent?: number;
  /** Only rows that expand get a chevron. */
  expanded?: boolean;
  /** A row in a tree that does not expand: room where the chevron would be, so names line up. */
  leaf?: boolean;
  /** main: the main Agent, larger. */
  variant?: 'main';
  menu?: MenuEntry[] | (() => MenuEntry[]);
  menuLabel?: string;
  renaming?: boolean;
  /** Called with the new name, or null when renaming was abandoned. */
  onRename?: (name: string | null) => void;
  onClick?: (event: MouseEvent<HTMLElement>) => void;
  rowProps?: RowProps;
  /** A drop over this row would land before it, after it or into it (a folder). */
  dropAt?: 'before' | 'after' | 'into' | null;
}) {
  const t = useT();
  const context = useContextMenu(menu ?? [], menuLabel ?? t('row.rename'));
  const [draft, setDraft] = useState(title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!renaming) return;
    setDraft(title);
    input.current?.focus();
    input.current?.select();
  }, [renaming, title]);

  const className = cx(
    'app-row',
    variant === 'main' && 'is-main',
    active && 'is-active',
    context.open && 'is-menu-open',
    dropAt && `is-drop-${dropAt}`,
  );
  const style = indent ? { paddingLeft: `calc(var(--gh-space-2) + ${indent} * var(--gh-space-4))` } : undefined;
  const body = (
    <>
      {expanded !== undefined && (
        <span className="app-row-chevron" aria-hidden>
          {expanded ? <ChevronDown size={icon.sm} /> : <ChevronRight size={icon.sm} />}
        </span>
      )}
      {expanded === undefined && leaf && <span className="app-row-chevron is-leaf" aria-hidden />}
      {leading && <span className="app-row-leading">{leading}</span>}
      <span className="app-row-title">{title}</span>
      {signal && <SignalMark signal={signal} />}
      {count !== undefined && count > 0 && <span className="app-count">{count}</span>}
    </>
  );

  if (renaming) {
    return (
      <div className={cx(className, 'is-renaming')} style={style}>
        {leading && <span className="app-row-leading">{leading}</span>}
        <input
          ref={input}
          className="app-row-input"
          value={draft}
          aria-label={t('row.rename')}
          maxLength={120}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => onRename?.(draft.trim() && draft.trim() !== title ? draft.trim() : null)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur();
            if (event.key === 'Escape') {
              event.stopPropagation();
              setDraft(title);
              onRename?.(null);
            }
          }}
        />
      </div>
    );
  }

  const own: Partial<typeof context.handlers> = menu ? context.handlers : {};
  const handlers = {
    ...rowProps,
    ...own,
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      rowProps?.onKeyDown?.(event);
      if (!event.defaultPrevented) own.onKeyDown?.(event);
    },
  };
  return (
    <>
      {href ? (
        <a
          className={className}
          style={style}
          href={href}
          aria-current={active ? 'page' : undefined}
          onClick={onClick}
          {...handlers}
        >
          {body}
        </a>
      ) : (
        <button
          type="button"
          className={className}
          style={style}
          aria-current={active ? 'true' : undefined}
          aria-expanded={expanded}
          onClick={onClick}
          {...handlers}
        >
          {body}
        </button>
      )}
      {context.menu}
    </>
  );
}

export function DirectorySection({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="app-directory-section" aria-label={title}>
      <div className="app-directory-section-title">
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </section>
  );
}
