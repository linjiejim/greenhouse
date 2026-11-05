/**
 * The few controls the library needs, drawn with the host's tokens (see apps/client/DESIGN.md):
 * controls 32 tall (28 in toolbars), radius 8, text 14, labels 13, hints 12, dialogs at fixed sizes.
 */
import { useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { create } from 'zustand';
import { Loader2, X } from 'lucide-react';

const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';

export function Button({
  variant = 'secondary',
  compact,
  className,
  busy,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; compact?: boolean; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-lg px-3 text-[14px] font-semibold whitespace-nowrap transition-colors disabled:cursor-default disabled:opacity-50',
        compact ? 'h-7' : 'h-8',
        variant === 'primary' && 'bg-accent text-on-accent hover:bg-accent-hover',
        variant === 'secondary' && 'border border-edge bg-surface-raised text-fg hover:bg-surface-muted',
        variant === 'ghost' && 'text-fg-secondary hover:bg-surface-muted hover:text-fg',
        variant === 'danger' && 'bg-destructive text-on-destructive hover:bg-destructive-hover',
        className,
      )}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className={cx(
        'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-secondary hover:bg-surface-muted hover:text-fg disabled:opacity-40',
        className,
      )}
    >
      {children}
    </button>
  );
}

const fieldClass =
  'rounded-lg border border-edge bg-surface-raised px-2.5 text-[14px] text-fg placeholder:text-fg-faint focus:border-accent focus:outline-none';

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement> & { compact?: boolean }) {
  const { compact, className, ...rest } = props;
  return <input {...rest} className={cx(fieldClass, 'w-full', compact ? 'h-7' : 'h-8', className)} />;
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea rows={3} {...props} className={cx(fieldClass, 'w-full py-1.5 leading-[22px]', props.className)} />;
}

export function Select({
  compact,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { compact?: boolean }) {
  return <select {...props} className={cx(fieldClass, compact ? 'h-7' : 'h-8', 'pr-7', className ?? 'w-full')} />;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[13px] font-semibold text-fg-secondary">{label}</span>
      {children}
      {hint ? <span className="text-[12px] text-fg-muted">{hint}</span> : null}
    </label>
  );
}

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex h-5 items-center rounded-md px-1.5 text-[12px] font-semibold',
        tone === 'neutral' && 'bg-surface-muted text-fg-secondary',
        tone === 'accent' && 'bg-primary-subtle text-primary-fg',
        tone === 'success' && 'bg-success-subtle text-success-fg',
        tone === 'warning' && 'bg-warning-subtle text-warning-fg',
        tone === 'danger' && 'bg-danger-subtle text-danger-fg',
        tone === 'info' && 'bg-info-subtle text-info-fg',
      )}
    >
      {children}
    </span>
  );
}

export function Chip({
  children,
  selected,
  onClick,
  onRemove,
  ai,
}: {
  children: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
  ai?: boolean;
}) {
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      className={cx(
        'inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-[13px]',
        selected ? 'border-accent bg-primary-subtle text-primary-fg' : 'border-edge bg-surface-raised text-fg',
        ai && !selected && 'border-dashed text-fg-secondary',
        onClick && 'hover:border-accent',
      )}
    >
      <span className="truncate">{children}</span>
      {onRemove ? (
        <span
          role="button"
          tabIndex={0}
          aria-label="remove"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          onKeyDown={(e) => e.key === 'Enter' && onRemove()}
          className="-mr-1 rounded-full p-0.5 text-fg-muted hover:text-fg"
        >
          <X size={12} />
        </span>
      ) : null}
    </Tag>
  );
}

export function TagInput({
  value,
  onChange,
  placeholder,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
}) {
  const [draft, setDraft] = useState('');
  const commit = (text: string) => {
    const next = text
      .split(/[,，\n]/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!next.length) return;
    const seen = new Set(value.map((t) => t.toLowerCase()));
    onChange([...value, ...next.filter((t) => !seen.has(t.toLowerCase()))].slice(0, 30));
    setDraft('');
  };
  return (
    <div className={cx(fieldClass, 'flex min-h-8 w-full flex-wrap items-center gap-1 py-1')}>
      {value.map((tag) => (
        <Chip key={tag} onRemove={() => onChange(value.filter((t) => t !== tag))}>
          {tag}
        </Chip>
      ))}
      <input
        value={draft}
        placeholder={value.length ? '' : placeholder}
        onChange={(e) => (/[,，]/.test(e.target.value) ? commit(e.target.value) : setDraft(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
        }}
        onBlur={() => commit(draft)}
        className="h-6 min-w-24 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-faint"
      />
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return <Loader2 size={size} className="animate-spin text-fg-muted" />;
}

export function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => window.innerWidth < 760);
  useEffect(() => {
    const onResize = () => setNarrow(window.innerWidth < 760);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return narrow;
}

const SIZES = { sm: 'w-[420px]', md: 'w-[560px] h-[600px]', lg: 'w-[760px] h-[640px]', xl: 'w-[960px] h-[680px]' };

/** A centred dialog of a fixed size on wide screens, a full-screen sheet on phones. Escape closes it. */
export function Dialog({
  title,
  size = 'md',
  onClose,
  footer,
  children,
}: {
  title: ReactNode;
  size?: keyof typeof SIZES;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const narrow = useNarrow();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    box.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previous?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={cx(
          'flex flex-col overflow-hidden bg-surface-canvas text-fg shadow-xl outline-none',
          narrow ? 'h-full w-full' : cx('max-h-[calc(100vh-48px)] max-w-[calc(100vw-48px)] rounded-xl', SIZES[size]),
        )}
      >
        <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-edge px-4">
          <div className="min-w-0 flex-1 truncate text-[15px] font-bold">{title}</div>
          <IconButton label="Close" onClick={onClose}>
            <X size={18} />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
        {footer ? <div className="flex shrink-0 justify-end gap-2 border-t border-edge px-4 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center">
      <div className="text-fg-faint">{icon}</div>
      <div className="text-[15px] font-bold text-fg">{title}</div>
      {hint ? <div className="max-w-sm text-[13px] text-fg-muted">{hint}</div> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

interface Toast {
  id: number;
  text: string;
  tone: 'success' | 'danger';
}
let toastId = 0;
export const useToasts = create<{ toasts: Toast[]; show: (text: string, tone?: Toast['tone']) => void }>((set) => ({
  toasts: [],
  show(text, tone = 'success') {
    const id = ++toastId;
    set((s) => ({ toasts: [...s.toasts, { id, text, tone }] }));
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 3200);
  },
}));
export const toast = (text: string) => useToasts.getState().show(text, 'success');
export const toastError = (text: string) => useToasts.getState().show(text, 'danger');

export function Toasts() {
  const toasts = useToasts((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cx(
            'rounded-lg px-3 py-2 text-[13px] font-semibold shadow-lg',
            t.tone === 'danger' ? 'bg-destructive text-on-destructive' : 'bg-fg text-surface-canvas',
          )}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}

// A sandboxed frame has no window.confirm (no allow-modals), so confirmation is our own dialog.
const useConfirm = create<{
  pending: { message: string; action: string; resolve: (ok: boolean) => void } | null;
}>(() => ({ pending: null }));

export function confirmAction(message: string, action: string): Promise<boolean> {
  return new Promise((resolve) => useConfirm.setState({ pending: { message, action, resolve } }));
}

export function ConfirmHost({ cancel }: { cancel: string }) {
  const pending = useConfirm((s) => s.pending);
  if (!pending) return null;
  const answer = (ok: boolean) => {
    useConfirm.setState({ pending: null });
    pending.resolve(ok);
  };
  return (
    <Dialog
      size="sm"
      title={pending.action}
      onClose={() => answer(false)}
      footer={
        <>
          <Button onClick={() => answer(false)}>{cancel}</Button>
          <Button variant="danger" onClick={() => answer(true)}>
            {pending.action}
          </Button>
        </>
      }
    >
      <p className="text-[14px] leading-[22px] text-fg">{pending.message}</p>
    </Dialog>
  );
}
