/**
 * The browser's one select (DESIGN.md Components): a button showing the choice and a listbox on the
 * shared overlay (focus, Escape, arrows), drawn like the app's menus in both appearances instead
 * of the system's popup. It takes `<option>` / `<optgroup>` children and calls
 * `onChange({ target: { value } })`, so it replaces a `<select>` in place.
 *
 * `clearable` makes it a list filter (jim-uiux filters): no "All" choice; the empty option's text
 * is the unset label (dashed), a set filter shows "Label: value" with ✕ to clear.
 */
import React, { Children, isValidElement, useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './core.web';
import { Overlay } from './overlay.web';
import { useT } from '../lib/i18n';

interface Choice {
  value: string;
  label: string;
  disabled?: boolean;
  group?: string;
}

/** Read `<option>` and `<optgroup>` children (maps and fragments included). */
export function choicesOf(children: React.ReactNode, group?: string): Choice[] {
  return Children.toArray(children).flatMap((child): Choice[] => {
    if (!isValidElement<{ value?: unknown; children?: React.ReactNode; disabled?: boolean; label?: string }>(child))
      return [];
    if (child.type === React.Fragment) return choicesOf(child.props.children, group);
    if (child.type === 'optgroup') return choicesOf(child.props.children, child.props.label);
    if (child.type !== 'option') return [];
    const text = Children.toArray(child.props.children).join('');
    return [{ value: String(child.props.value ?? text), label: text, disabled: child.props.disabled, group }];
  });
}

export function Select({
  value,
  onChange,
  children,
  clearable,
  disabled,
  id,
  className,
  style,
  'aria-label': ariaLabel,
  testID,
}: {
  value?: string | number;
  onChange?: (event: { target: { value: string } }) => void;
  children: React.ReactNode;
  /** A list filter: the empty option is the unset label; a set value gets ✕. */
  clearable?: boolean;
  disabled?: boolean;
  id?: string;
  className?: string;
  style?: React.CSSProperties;
  'aria-label'?: string;
  testID?: string;
}) {
  const t = useT();
  const choices = useMemo(() => choicesOf(children), [children]);
  const current = String(value ?? '');
  const chosen = choices.find((c) => c.value === current);
  const unset = clearable ? choices.find((c) => c.value === '') : undefined;
  const listed = clearable ? choices.filter((c) => c.value !== '') : choices;
  const isSet = clearable ? current !== '' : true;
  const [open, setOpen] = useState<{ x: number; y: number; width: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pick = (next: string) => {
    setOpen(null);
    if (next !== current) onChange?.({ target: { value: next } });
    button.current?.focus();
  };
  const show = () => {
    const box = button.current?.getBoundingClientRect();
    if (box) setOpen({ x: box.left, y: box.bottom + 4, width: box.width });
  };
  const text = clearable
    ? isSet
      ? `${unset?.label ?? ariaLabel ?? ''}${unset?.label || ariaLabel ? '：' : ''}${chosen?.label ?? current}`
      : (unset?.label ?? ariaLabel ?? '')
    : (chosen?.label ?? '');
  return (
    // `gh-input` belongs on the trigger, which already has it; a replaced <select> may still pass it
    <span
      className={['gh-select', ...(className ?? '').split(' ').filter((c) => c && c !== 'gh-input')].join(' ')}
      style={style}
      data-testid={testID}
    >
      <button
        ref={button}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={!!open}
        aria-label={ariaLabel}
        disabled={disabled}
        data-value={current}
        data-unset={clearable && !isSet ? '' : undefined}
        data-set={clearable && isSet ? '' : undefined}
        className="gh-input gh-select-trigger"
        onClick={() => (open ? setOpen(null) : show())}
        onKeyDown={(e) => {
          if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="gh-select-value">{text}</span>
        {clearable && isSet ? null : <Icon name="chevD" size={14} />}
      </button>
      {clearable && isSet && !disabled ? (
        <button
          type="button"
          className="gh-select-clear"
          aria-label={`${t('common.clear')} ${unset?.label ?? ariaLabel ?? ''}`.trim()}
          onClick={() => onChange?.({ target: { value: '' } })}
        >
          <Icon name="x" size={12} />
        </button>
      ) : null}
      {open ? (
        <Listbox
          choices={listed}
          current={current}
          point={open}
          label={ariaLabel ?? unset?.label}
          pick={pick}
          close={() => {
            setOpen(null);
            button.current?.focus();
          }}
        />
      ) : null}
    </span>
  );
}

function Listbox({
  choices,
  current,
  point,
  label,
  pick,
  close,
}: {
  choices: Choice[];
  current: string;
  point: { x: number; y: number; width: number };
  label?: string;
  pick: (value: string) => void;
  close: () => void;
}) {
  const t = useT();
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }, []);
  let lastGroup: string | undefined;
  return (
    <Overlay
      role="listbox"
      modal={false}
      label={label}
      point={{ x: point.x, y: point.y }}
      onClose={close}
      panelStyle={{ minWidth: Math.max(160, point.width), maxHeight: 320, fontSize: 14, lineHeight: '20px' }}
    >
      <div ref={list}>
        {choices.length ? (
          choices.map((c) => {
            const header = c.group && c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <React.Fragment key={c.value}>
                {header ? <div className="gh-menu-title">{header}</div> : null}
                <button
                  type="button"
                  role="option"
                  data-value={c.value}
                  aria-selected={c.value === current}
                  disabled={c.disabled}
                  className="gh-menu-item"
                  onClick={() => pick(c.value)}
                >
                  <span>{c.label}</span>
                  {c.value === current ? <Icon name="check" size={14} /> : null}
                </button>
              </React.Fragment>
            );
          })
        ) : (
          <div className="gh-menu-title">{t('common.noMatches')}</div>
        )}
      </div>
    </Overlay>
  );
}
