/**
 * Actions and inputs (docs/design-system/components.md, 动作 and 输入): buttons, fields, text
 * inputs, the search field, segmented controls, switches, checkboxes, radios, the write-only
 * secret field and tabs. Every control has a visible keyboard focus, a disabled state and works
 * with touch; sizes come from the tokens.
 */

import {
  Children,
  cloneElement,
  isValidElement,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { Check, KeyRound, LoaderCircle, Minus, Search, X } from 'lucide-react';
import { icon } from '../tokens/haven';
import { cx, useKitStrings } from './provider';
import { HelpHint, useTooltip } from './tooltip';

/** Spinners only appear inside buttons and inline next to a status (components.md, 反馈). */
export function Spinner({ size = icon.md, className }: { size?: number; className?: string }) {
  return <LoaderCircle size={size} strokeWidth={icon.stroke} className={cx('gh-spinner', className)} aria-hidden />;
}

export type ButtonKind = 'primary' | 'secondary' | 'ghost' | 'danger';

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  kind?: ButtonKind;
  /** sm 28 (tables, compact toolbars) · md 36 · lg 44 (touch and sign-in). */
  size?: 'sm' | 'md' | 'lg';
  /** Keeps its width and label, shows a spinner and ignores presses. */
  loading?: boolean;
  /** With `disabled`: the button stays focusable and shows why in a tooltip. */
  disabledReason?: string;
  ref?: Ref<HTMLButtonElement>;
};

function ButtonBase({
  kind = 'secondary',
  size = 'md',
  loading = false,
  disabled = false,
  disabledReason,
  tooltip,
  describe,
  className,
  type = 'button',
  onClick,
  children,
  ...props
}: ButtonProps & { tooltip?: string; describe: boolean }) {
  const reason = disabled ? disabledReason : undefined;
  // A reason or a pending action keeps the button focusable: aria-disabled instead of disabled.
  const inactive = loading || !!reason;
  const tip = useTooltip(tooltip ?? '', { describe, enabled: !!tooltip });
  const bound = tip.bind({
    ...props,
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      // Also stops a submit button from submitting its form.
      if (inactive) event.preventDefault();
      else onClick?.(event);
    },
  });
  return (
    <>
      <button
        type={type}
        {...bound}
        disabled={(disabled && !reason) || undefined}
        aria-disabled={inactive || undefined}
        aria-busy={loading || undefined}
        className={cx(
          'gh-button',
          `gh-button-${kind}`,
          size !== 'md' && `gh-button-${size}`,
          loading && 'is-loading',
          className,
        )}
      >
        {loading && <Spinner className="gh-button-spinner" />}
        <span className="gh-button-label">{children}</span>
      </button>
      {tip.tooltip}
    </>
  );
}

/** primary: one per region · secondary · ghost · danger (light red; ConfirmDialog makes it solid). */
export function Button(props: ButtonProps) {
  return <ButtonBase {...props} tooltip={props.disabled ? props.disabledReason : undefined} describe />;
}

/** Icon only. The label is its accessible name and its tooltip. Visual 28 or 32, a 44 hit area on touch. */
export function IconButton({
  label,
  size = 'md',
  className,
  ...props
}: Omit<ButtonProps, 'kind' | 'size'> & { label: string; size?: 'sm' | 'md' }) {
  const reason = props.disabled ? props.disabledReason : undefined;
  return (
    <ButtonBase
      {...props}
      kind="ghost"
      aria-label={label}
      tooltip={reason ? `${label} · ${reason}` : label}
      describe={!!reason}
      className={cx('gh-icon-button', size === 'sm' && 'gh-icon-button-sm', className)}
    />
  );
}

/**
 * Label (with an optional "?" and the required mark), the control, then either the error or one
 * sentence that changes what the user does. A single control child gets aria-invalid and
 * aria-describedby wired to the error or that sentence.
 */
export function Field({
  label,
  error,
  description,
  help,
  required = false,
  children,
}: {
  label: string;
  error?: string;
  description?: string;
  help?: ReactNode;
  required?: boolean;
  children: ReactNode;
}) {
  const t = useKitStrings();
  const id = useId();
  const note = error ? `${id}-error` : description ? `${id}-note` : undefined;
  let control = children;
  if (Children.count(children) === 1 && isValidElement(children)) {
    const element = children as ReactElement<Record<string, unknown>>;
    control = cloneElement(element, {
      'aria-invalid': element.props['aria-invalid'] ?? (error ? true : undefined),
      'aria-describedby':
        [element.props['aria-describedby'] as string | undefined, note].filter(Boolean).join(' ') || undefined,
    });
  }
  return (
    <div className="gh-field">
      <label className="gh-field-label">
        <span className="gh-field-label-text">
          {label}
          {required && <span className="gh-field-required"> · {t.required}</span>}
        </span>
        {control}
      </label>
      {help && (
        <span className="gh-field-help">
          <HelpHint label={label}>{help}</HelpHint>
        </span>
      )}
      {error ? (
        <span className="gh-field-error" id={note} role="alert">
          {error}
        </span>
      ) : (
        description && (
          <span className="gh-field-description" id={note}>
            {description}
          </span>
        )
      )}
    </div>
  );
}

export function Input({
  size = 'md',
  className,
  ...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> & { size?: 'md' | 'lg'; ref?: Ref<HTMLInputElement> }) {
  return <input {...props} className={cx('gh-input', size === 'lg' && 'gh-input-lg', className)} />;
}

/** Grows with its content up to `maxRows`, then scrolls inside. */
export function TextArea({
  className,
  maxRows = 12,
  ref,
  onInput,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { maxRows?: number; ref?: Ref<HTMLTextAreaElement> }) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const element = own.current;
    if (!element) return;
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || 0;
    const frame = element.offsetHeight - element.clientHeight;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) || 0;
    element.style.height = 'auto';
    const max = line ? line * maxRows + padding + frame : Infinity;
    const wanted = element.scrollHeight + frame;
    element.style.height = `${Math.min(wanted, max)}px`;
    element.style.overflowY = wanted > max ? 'auto' : 'hidden';
  };
  useLayoutEffect(fit, [props.value, maxRows]);
  return (
    <textarea
      {...props}
      ref={(node) => {
        own.current = node;
        if (typeof ref === 'function') ref(node);
        else if (ref) (ref as { current: HTMLTextAreaElement | null }).current = node;
      }}
      className={cx('gh-input', 'gh-textarea', className)}
      onInput={(event) => {
        fit();
        onInput?.(event);
      }}
    />
  );
}

/** Leading magnifier. Escape clears the text first, then leaves (`onEscape`). */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  autoFocus = false,
  onEscape,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  autoFocus?: boolean;
  onEscape?: () => void;
}) {
  const t = useKitStrings();
  return (
    <div className="gh-search-field">
      <Search size={icon.md} strokeWidth={icon.stroke} className="gh-search-icon" />
      <input
        className="gh-search-input"
        aria-label={label ?? t.search}
        value={value}
        autoFocus={autoFocus}
        placeholder={placeholder ?? t.search}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          if (value) onChange('');
          else onEscape?.();
        }}
      />
      {value && (
        <IconButton label={t.clearSearch} size="sm" onClick={() => onChange('')}>
          <X size={icon.sm} strokeWidth={icon.stroke} />
        </IconButton>
      )}
    </div>
  );
}

/** Arrow keys, Home and End step through a row of options, wrapping at the ends. */
function stepKey(event: KeyboardEvent, index: number, count: number): number | null {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  if (event.key === 'Home') return 0;
  if (event.key === 'End') return count - 1;
  if (forward) return (index + 1) % count;
  if (back) return (index - 1 + count) % count;
  return null;
}

/** A string is its own label; an object keeps a stable value apart from its (translated) label. */
export type SegmentedItem = string | { value: string; label: string };

/** 2–4 mutually exclusive views or scopes; more go into Tabs or a Select. */
export function Segmented({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly SegmentedItem[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  const options = items.map((item) => (typeof item === 'string' ? { value: item, label: item } : item));
  const current = options.some((option) => option.value === value) ? value : options[0]?.value;
  return (
    <div className="gh-segmented" role="radiogroup" aria-label={label}>
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === current ? 0 : -1}
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            const next = stepKey(event, index, options.length);
            if (next === null) return;
            event.preventDefault();
            onChange(options[next].value);
            (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Only for settings that apply at once; on failure the caller puts the old value back and says why. */
export function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className="gh-switch"
      onClick={() => onChange(!checked)}
    >
      <span className="gh-switch-knob" />
    </button>
  );
}

type ChoiceProps = {
  checked: boolean;
  /** Visible text; without it pass `aria-label`. */
  label?: ReactNode;
  disabled?: boolean;
  name?: string;
  value?: string;
  'aria-label'?: string;
};

/** A drawn 16 box over a native checkbox; `indeterminate` shows a dash. */
export function Checkbox({
  checked,
  indeterminate = false,
  onChange,
  label,
  disabled = false,
  ...props
}: ChoiceProps & { indeterminate?: boolean; onChange: (checked: boolean) => void }) {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (input.current) input.current.indeterminate = indeterminate;
  }, [indeterminate]);
  const mark = indeterminate ? 'mixed' : checked ? 'on' : 'off';
  return (
    <label className={cx('gh-choice', disabled && 'is-disabled')}>
      <span className="gh-choice-control">
        <input
          {...props}
          ref={input}
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className={cx('gh-checkbox', `is-${mark}`)} aria-hidden>
          {mark === 'mixed' ? <Minus strokeWidth={3} /> : mark === 'on' ? <Check strokeWidth={3} /> : null}
        </span>
      </span>
      {label}
    </label>
  );
}

export function Radio({
  checked,
  onChange,
  label,
  disabled = false,
  ...props
}: ChoiceProps & { onChange: () => void }) {
  return (
    <label className={cx('gh-choice', disabled && 'is-disabled')}>
      <span className="gh-choice-control">
        <input {...props} type="radio" checked={checked} disabled={disabled} onChange={() => onChange()} />
        <span className={cx('gh-radio', checked && 'is-on')} aria-hidden />
      </span>
      {label}
    </label>
  );
}

/** Write-only: shows whether a secret is configured, never its value; replacing clears the input. */
export function SecretField({
  label,
  configured,
  onSave,
  help,
}: {
  label: string;
  configured: boolean;
  onSave: (value: string) => void;
  help?: ReactNode;
}) {
  const t = useKitStrings();
  const [editing, setEditing] = useState(!configured);
  const [value, setValue] = useState('');
  const close = () => {
    setValue('');
    setEditing(false);
  };
  return (
    <Field label={label} help={help}>
      {editing ? (
        <span className="gh-secret-edit">
          <Input
            type="password"
            autoComplete="off"
            placeholder={t.pasteKey}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          {configured && <Button onClick={close}>{t.cancel}</Button>}
          <Button
            kind="primary"
            disabled={!value.trim()}
            onClick={() => {
              const secret = value;
              close();
              onSave(secret);
            }}
          >
            {t.save}
          </Button>
        </span>
      ) : (
        <span className="gh-secret-configured">
          <KeyRound size={icon.md} strokeWidth={icon.stroke} />
          {t.configured}
          <Button kind="ghost" size="sm" onClick={() => setEditing(true)}>
            {t.replace}
          </Button>
        </span>
      )}
    </Field>
  );
}

/** Underlined views of one object; hidden with fewer than two. */
export function Tabs({
  items,
  value,
  onChange,
  label,
}: {
  items: readonly string[];
  value: string;
  onChange: (item: string) => void;
  label?: string;
}) {
  const t = useKitStrings();
  const id = useId();
  if (items.length < 2) return null;
  // One tab is always reachable with Tab, even before a valid value arrives.
  const current = items.includes(value) ? value : items[0];
  return (
    <div className="gh-tabs" role="tablist" aria-label={label ?? t.views}>
      {items.map((item, index) => (
        <button
          key={item}
          type="button"
          role="tab"
          id={`${id}-${index}`}
          aria-selected={item === value}
          tabIndex={item === current ? 0 : -1}
          onClick={() => onChange(item)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') return;
            const next = stepKey(event, index, items.length);
            if (next === null) return;
            event.preventDefault();
            onChange(items[next]);
            (event.currentTarget.parentElement?.children[next] as HTMLElement | undefined)?.focus();
          }}
        >
          {item}
        </button>
      ))}
    </div>
  );
}
