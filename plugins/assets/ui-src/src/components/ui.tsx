/**
 * The library's controls: the shared kit (`@greenhouse/ui-tokens/react`, drawn to the host's specs)
 * plus the two pieces only it needs, Chip and TagInput.
 */
import { useState, type ReactNode } from 'react';
import { CloseIcon, cx, useKitStrings } from '@greenhouse/ui-tokens/react';

export {
  Badge,
  Button,
  confirm,
  Dialog,
  DetailList,
  Drawer,
  Field,
  IconButton,
  Input as TextInput,
  notify,
  SearchInput,
  Select,
  Skeleton,
  Spinner,
  StateView,
  TextArea,
  useDelayedFlag,
  useHostTitle,
} from '@greenhouse/ui-tokens/react';
export { cx };

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
  const s = useKitStrings();
  const Tag = onClick ? 'button' : 'span';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? selected : undefined}
      className={cx(
        'inline-flex h-7 max-w-full items-center gap-1 rounded-full border px-2.5 text-body-sm pointer-coarse:h-9',
        selected ? 'border-ring bg-selected text-primary-fg' : 'border-border bg-card text-foreground',
        ai && !selected && 'border-dashed text-muted-foreground',
        onClick && 'hover:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
    >
      <span className="truncate">{children}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`${s.close} ${typeof children === 'string' ? children : ''}`.trim()}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="-mr-1.5 inline-flex h-6 w-6 items-center justify-center rounded-full text-faint-foreground hover:bg-hover hover:text-foreground pointer-coarse:h-9 pointer-coarse:w-9"
        >
          <CloseIcon size={12} />
        </button>
      ) : null}
    </Tag>
  );
}

export function TagInput({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  id?: string;
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
    <div className="flex min-h-8 w-full flex-wrap items-center gap-1 rounded-control border border-input bg-card px-1.5 py-1 focus-within:border-ring">
      {value.map((tag) => (
        <Chip key={tag} onRemove={() => onChange(value.filter((t) => t !== tag))}>
          {tag}
        </Chip>
      ))}
      <input
        id={id}
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
        className="h-6 min-w-24 flex-1 bg-transparent px-1 text-body outline-none placeholder:text-faint-foreground"
      />
    </div>
  );
}
