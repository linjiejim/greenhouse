/**
 * Pickers drawn in the Haven style instead of the browser's own (docs/design-system/components.md,
 * 输入): Select, MultiSelect, DatePicker and DateRangePicker. Each trigger is as tall as an input,
 * opens one floating panel and works with the keyboard alone; Escape closes only the panel.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { icon } from '../tokens/haven';
import { IconButton } from './controls';
import { useDismiss, useFloating } from './floating';
import { cx, useKitStrings } from './provider';
import { kitStrings, weekdayIndex, type KitLocale, type KitStrings } from './strings';

export type SelectOption =
  | string
  | { value: string; label?: string; description?: string; icon?: ReactNode; disabled?: boolean };
type Item = { value: string; label: string; description?: string; icon?: ReactNode; disabled?: boolean };
const normalize = (options: readonly SelectOption[]): Item[] =>
  options.map((option) =>
    typeof option === 'string' ? { value: option, label: option } : { ...option, label: option.label ?? option.value },
  );

/** Lists longer than this get a search field. */
const SEARCH_FROM = 8;

type FieldProps = {
  /** Accessible name of the trigger. */
  label: string;
  placeholder?: string;
  disabled?: boolean;
  'aria-invalid'?: boolean | 'true' | 'false';
  'aria-describedby'?: string;
};
const invalid = (value: FieldProps['aria-invalid']) => value === true || value === 'true' || undefined;

/** Keyboard model shared by Select and MultiSelect while the list is open. */
function useListKeys(items: Item[], onPick: (item: Item) => void, onClose: () => void) {
  const [active, setActive] = useState(0);
  const step = (from: number, delta: number) => {
    for (let index = 1; index <= items.length; index++) {
      const next = (from + delta * index + items.length * index) % items.length;
      if (!items[next].disabled) return next;
    }
    return from;
  };
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!items.length && event.key !== 'Escape') return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((value) => step(value, event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      setActive(step(event.key === 'Home' ? -1 : items.length, event.key === 'Home' ? 1 : -1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (items[active] && !items[active].disabled) onPick(items[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Tab') onClose();
  };
  return { active, setActive, onKeyDown };
}

function OptionList({
  id,
  label,
  items,
  active,
  setActive,
  isSelected,
  onPick,
  multiple = false,
}: {
  id: string;
  label: string;
  items: Item[];
  active: number;
  setActive: (index: number) => void;
  isSelected: (item: Item) => boolean;
  onPick: (item: Item) => void;
  multiple?: boolean;
}) {
  const t = useKitStrings();
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [id, active]);
  return (
    <div
      role="listbox"
      id={id}
      aria-label={label}
      aria-multiselectable={multiple || undefined}
      className="gh-picker-list"
    >
      {items.map((item, index) => (
        <div
          key={item.value}
          id={`${id}-${index}`}
          role="option"
          aria-selected={isSelected(item)}
          aria-disabled={item.disabled || undefined}
          className={cx('gh-picker-option', index === active && 'is-active')}
          onPointerMove={() => !item.disabled && setActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => !item.disabled && onPick(item)}
        >
          {multiple && (
            <span className={cx('gh-checkbox', isSelected(item) ? 'is-on' : 'is-off')} aria-hidden>
              {isSelected(item) && <Check strokeWidth={3} />}
            </span>
          )}
          {item.icon && <span className="gh-picker-option-icon">{item.icon}</span>}
          <span className="gh-picker-option-text">
            <span>{item.label}</span>
            {item.description && <span className="gh-picker-option-description">{item.description}</span>}
          </span>
          {!multiple && isSelected(item) && (
            <Check size={icon.md} strokeWidth={icon.stroke} className="gh-picker-check" />
          )}
        </div>
      ))}
      {!items.length && <div className="gh-picker-empty">{t.noMatches}</div>}
    </div>
  );
}

function SearchBox({
  value,
  onChange,
  onKeyDown,
  listId,
  activeId,
}: {
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  listId: string;
  activeId?: string;
}) {
  const t = useKitStrings();
  return (
    <div className="gh-picker-search">
      <Search size={icon.sm} strokeWidth={icon.stroke} />
      <input
        autoFocus
        aria-label={t.searchOptions}
        aria-controls={listId}
        aria-activedescendant={activeId}
        placeholder={t.search}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

const matches = (item: Item, query: string) =>
  !query || `${item.label} ${item.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());

/**
 * One value from a list. Arrow keys open it and move, Enter or Space picks, Escape closes only
 * the list; closed, a letter jumps to the next option that starts with it. Lists longer than
 * eight get a search field; options can carry a description and be disabled.
 */
export function Select({
  label,
  value,
  options,
  onChange,
  placeholder,
  disabled = false,
  searchable,
  size = 'md',
  className,
  'aria-invalid': ariaInvalid,
  'aria-describedby': describedBy,
}: FieldProps & {
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  searchable?: boolean;
  /** sm 28 for table cells and compact toolbars. */
  size?: 'sm' | 'md';
  className?: string;
}) {
  const t = useKitStrings();
  const all = normalize(options);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const search = searchable ?? all.length > SEARCH_FROM;
  const items = all.filter((item) => matches(item, query));
  const selected = all.find((item) => item.value === value);
  const close = (restore = true) => {
    setOpen(false);
    setQuery('');
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  const pick = (item: Item) => {
    onChange(item.value);
    close();
  };
  const keys = useListKeys(items, pick, close);
  const { panel, style } = useFloating(open, {
    rect: () => trigger.current?.getBoundingClientRect() ?? null,
    matchWidth: true,
  });
  useDismiss(open, () => close(false), [panel, trigger]);
  const show = () => {
    keys.setActive(Math.max(0, selected ? all.indexOf(selected) : 0));
    setOpen(true);
  };
  const typeahead = (key: string) => {
    const start = selected ? all.indexOf(selected) : -1;
    const next = [...all.slice(start + 1), ...all.slice(0, start + 1)].find(
      (item) => !item.disabled && item.label.toLowerCase().startsWith(key.toLowerCase()),
    );
    if (next) onChange(next.value);
  };
  return (
    <span className={cx('gh-select', size === 'sm' && 'gh-select-sm', className)}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !search && items[keys.active] ? `${listId}-${keys.active}` : undefined}
        aria-invalid={invalid(ariaInvalid)}
        aria-describedby={describedBy}
        disabled={disabled}
        className="gh-picker-trigger"
        // Keys are handled on keydown; preventing their default also stops the click a browser derives
        // from Enter or Space, so onClick only sees pointers and assistive technology.
        onClick={() => (open ? close() : show())}
        onKeyUp={(event) => {
          if (event.key === ' ') event.preventDefault();
        }}
        onKeyDown={(event) => {
          if (open && !search) {
            if (event.key === ' ') {
              event.preventDefault();
              const item = items[keys.active];
              if (item && !item.disabled) pick(item);
            } else keys.onKeyDown(event);
          } else if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
            event.preventDefault();
            show();
          } else if (!open && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey)
            typeahead(event.key);
        }}
      >
        {selected?.icon}
        <span className={cx('gh-picker-value', !selected && 'is-placeholder')}>
          {selected?.label ?? placeholder ?? t.choose}
        </span>
        <ChevronDown size={icon.sm} strokeWidth={icon.stroke} className="gh-picker-chevron" />
      </button>
      {open && (
        <div ref={panel} className="gh-picker-panel" style={style}>
          {search && (
            <SearchBox
              value={query}
              listId={listId}
              activeId={items[keys.active] ? `${listId}-${keys.active}` : undefined}
              onChange={(next) => {
                setQuery(next);
                keys.setActive(0);
              }}
              onKeyDown={keys.onKeyDown}
            />
          )}
          <OptionList
            id={listId}
            label={label}
            items={items}
            active={keys.active}
            setActive={keys.setActive}
            isSelected={(item) => item.value === value}
            onPick={pick}
          />
        </div>
      )}
    </span>
  );
}

/**
 * Several values. The trigger shows the first `max` and "+N"; the list stays open for picking
 * more, with a search field and 清除; Backspace in the empty search removes the last value.
 * Where a pick saves at once, save in `onClose`: one save for everything picked while it was open.
 */
export function MultiSelect({
  label,
  value,
  options,
  onChange,
  onClose,
  placeholder,
  disabled = false,
  max = 2,
  'aria-invalid': ariaInvalid,
  'aria-describedby': describedBy,
}: FieldProps & {
  value: string[];
  options: readonly SelectOption[];
  onChange: (value: string[]) => void;
  /** The list closed (Escape, Tab, the trigger, a press outside). */
  onClose?: () => void;
  /** Chips shown before "+N". */
  max?: number;
}) {
  const t = useKitStrings();
  const all = normalize(options);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const listId = useId();
  const items = all.filter((item) => matches(item, query));
  const chosen = all.filter((item) => value.includes(item.value));
  const close = (restore = true) => {
    setOpen(false);
    setQuery('');
    if (restore) trigger.current?.focus({ preventScroll: true });
    onClose?.();
  };
  const toggle = (item: Item) =>
    onChange(value.includes(item.value) ? value.filter((entry) => entry !== item.value) : [...value, item.value]);
  const keys = useListKeys(items, toggle, close);
  const { panel, style } = useFloating(open, {
    rect: () => trigger.current?.getBoundingClientRect() ?? null,
    matchWidth: true,
  });
  useDismiss(open, () => close(false), [panel, trigger]);
  return (
    <span className="gh-select gh-select-multi">
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-invalid={invalid(ariaInvalid)}
        aria-describedby={describedBy}
        disabled={disabled}
        className="gh-picker-trigger"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={cx('gh-picker-value', 'gh-picker-chips', !chosen.length && 'is-placeholder')}>
          {chosen.length
            ? chosen.slice(0, max).map((item) => (
                <span key={item.value} className="gh-chip">
                  {item.label}
                </span>
              ))
            : (placeholder ?? t.choose)}
          {chosen.length > max && <span className="gh-chip is-more">+{chosen.length - max}</span>}
        </span>
        <ChevronDown size={icon.sm} strokeWidth={icon.stroke} className="gh-picker-chevron" />
      </button>
      {open && (
        <div ref={panel} className="gh-picker-panel" style={style}>
          <SearchBox
            value={query}
            listId={listId}
            activeId={items[keys.active] ? `${listId}-${keys.active}` : undefined}
            onChange={(next) => {
              setQuery(next);
              keys.setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Backspace' && !query && value.length) onChange(value.slice(0, -1));
              keys.onKeyDown(event);
            }}
          />
          <OptionList
            id={listId}
            label={label}
            items={items}
            active={keys.active}
            setActive={keys.setActive}
            isSelected={(item) => value.includes(item.value)}
            onPick={toggle}
            multiple
          />
          <div className="gh-picker-footer">
            <span className="gh-picker-footer-note">{t.selectedCount(value.length)}</span>
            <button type="button" className="gh-text-button" disabled={!value.length} onClick={() => onChange([])}>
              {t.clear}
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// ─── Dates ───

const pad = (value: number) => String(value).padStart(2, '0');
/** YYYY-MM-DD in local time. */
export const toISO = (date: Date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const fromISO = (value: string) => {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
};
const addDays = (date: Date, days: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
const addMonths = (date: Date, months: number) => {
  const target = new Date(date.getFullYear(), date.getMonth() + months, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), last));
};

const format = (strings: KitStrings, value: string) => {
  if (!value) return '';
  const date = fromISO(value);
  return strings.date(date, date.getFullYear() !== new Date().getFullYear());
};

/** "10 月 16 日 周五" this year, "2025 年 10 月 3 日" otherwise (docs/design-system/content.md). */
export function formatDate(value: string, locale: KitLocale = 'zh') {
  return format(kitStrings[locale], value);
}

function Calendar({
  focus,
  setFocus,
  isSelected,
  inRange,
  isDisabled,
  onPick,
  onHover,
  onClose,
}: {
  focus: Date;
  setFocus: (date: Date) => void;
  isSelected: (iso: string) => boolean;
  inRange?: (iso: string) => boolean;
  isDisabled: (iso: string) => boolean;
  onPick: (iso: string) => void;
  onHover?: (iso: string) => void;
  onClose: () => void;
}) {
  const t = useKitStrings();
  const grid = useRef<HTMLDivElement>(null);
  const today = toISO(new Date());
  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const start = addDays(first, -weekdayIndex(first));
  const days = Array.from({ length: 42 }, (_, index) => addDays(start, index));
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>(`[data-date="${toISO(focus)}"]`)?.focus({ preventScroll: true });
  }, [focus]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, () => Date> = {
      ArrowLeft: () => addDays(focus, -1),
      ArrowRight: () => addDays(focus, 1),
      ArrowUp: () => addDays(focus, -7),
      ArrowDown: () => addDays(focus, 7),
      Home: () => addDays(focus, -weekdayIndex(focus)),
      End: () => addDays(focus, 6 - weekdayIndex(focus)),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
    };
    if (moves[event.key]) {
      event.preventDefault();
      setFocus(moves[event.key]());
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      const iso = toISO(focus);
      if (!isDisabled(iso)) onPick(iso);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="gh-calendar">
      <div className="gh-calendar-header">
        <strong aria-live="polite">{t.month(focus)}</strong>
        <span className="gh-calendar-spacer" />
        <IconButton label={t.previousMonth} size="sm" onClick={() => setFocus(addMonths(focus, -1))}>
          <ChevronLeft size={icon.md} strokeWidth={icon.stroke} />
        </IconButton>
        <IconButton label={t.nextMonth} size="sm" onClick={() => setFocus(addMonths(focus, 1))}>
          <ChevronRight size={icon.md} strokeWidth={icon.stroke} />
        </IconButton>
      </div>
      <div className="gh-calendar-grid" role="grid" aria-label={t.month(focus)} ref={grid} onKeyDown={onKeyDown}>
        <div role="row" className="gh-calendar-row">
          {t.weekdays.map((day) => (
            <span key={day} role="columnheader" className="gh-calendar-weekday">
              {day}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, row) => (
          <div role="row" className="gh-calendar-row" key={row}>
            {days.slice(row * 7, row * 7 + 7).map((day) => {
              const iso = toISO(day);
              // Unavailable days stay focusable (aria-disabled), so the arrow keys can cross them.
              const unavailable = isDisabled(iso);
              return (
                <span role="gridcell" key={iso} aria-selected={isSelected(iso)}>
                  <button
                    type="button"
                    data-date={iso}
                    tabIndex={iso === toISO(focus) ? 0 : -1}
                    aria-disabled={unavailable || undefined}
                    aria-label={t.day(day)}
                    aria-current={iso === today ? 'date' : undefined}
                    className={cx(
                      'gh-calendar-day',
                      day.getMonth() !== focus.getMonth() && 'is-outside',
                      isSelected(iso) && 'is-selected',
                      inRange?.(iso) && 'is-in-range',
                    )}
                    onClick={() => !unavailable && onPick(iso)}
                    onPointerEnter={() => onHover?.(iso)}
                  >
                    {day.getDate()}
                  </button>
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

function DateTrigger({
  label,
  text,
  placeholder,
  open,
  disabled,
  invalid: isInvalid,
  describedBy,
  onToggle,
  onClear,
  trigger,
}: {
  label: string;
  text: string;
  placeholder: string;
  open: boolean;
  disabled: boolean;
  invalid?: true;
  describedBy?: string;
  onToggle: () => void;
  onClear?: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  const t = useKitStrings();
  return (
    <span className="gh-date-trigger">
      <button
        ref={trigger}
        type="button"
        aria-label={text ? t.labelWithValue(label, text) : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={isInvalid}
        aria-describedby={describedBy}
        disabled={disabled}
        className="gh-picker-trigger"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <CalendarDays size={icon.md} strokeWidth={icon.stroke} className="gh-picker-leading" />
        <span className={cx('gh-picker-value', !text && 'is-placeholder')}>{text || placeholder}</span>
      </button>
      {onClear && text && !disabled && (
        <button type="button" className="gh-picker-clear" aria-label={t.clearValue(label)} onClick={onClear}>
          <X size={icon.sm} strokeWidth={icon.stroke} />
        </button>
      )}
    </span>
  );
}

/**
 * A date as YYYY-MM-DD. One month at a time, Monday first; today is outlined, the value filled,
 * dates outside `min`/`max` struck through. Arrows move by day and week, PageUp and PageDown by
 * month, Home and End to the week's ends, Enter picks, Escape closes.
 */
export function DatePicker({
  label,
  value,
  onChange,
  placeholder,
  min,
  max,
  disabled = false,
  clearable = true,
  'aria-invalid': ariaInvalid,
  'aria-describedby': describedBy,
}: FieldProps & {
  /** YYYY-MM-DD or ''. */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
  clearable?: boolean;
}) {
  const t = useKitStrings();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(() => (value ? fromISO(value) : new Date()));
  const trigger = useRef<HTMLButtonElement>(null);
  const { panel, style } = useFloating(open, { rect: () => trigger.current?.getBoundingClientRect() ?? null });
  const close = (restore = true) => {
    setOpen(false);
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  useDismiss(open, () => close(false), [panel, trigger]);
  const isDisabled = (iso: string) => (!!min && iso < min) || (!!max && iso > max);
  const pick = (iso: string) => {
    onChange(iso);
    close();
  };
  return (
    <span className="gh-date-picker">
      <DateTrigger
        label={label}
        text={format(t, value)}
        placeholder={placeholder ?? t.chooseDate}
        open={open}
        disabled={disabled}
        invalid={invalid(ariaInvalid)}
        describedBy={describedBy}
        trigger={trigger}
        onToggle={() => {
          setFocus(value ? fromISO(value) : new Date());
          setOpen(!open);
        }}
        onClear={clearable ? () => onChange('') : undefined}
      />
      {open && (
        <div ref={panel} role="dialog" aria-label={label} className="gh-picker-panel gh-calendar-panel" style={style}>
          <Calendar
            focus={focus}
            setFocus={setFocus}
            isSelected={(iso) => iso === value}
            isDisabled={isDisabled}
            onPick={pick}
            onClose={close}
          />
          <div className="gh-picker-footer">
            <button
              type="button"
              className="gh-text-button"
              disabled={isDisabled(toISO(new Date()))}
              onClick={() => pick(toISO(new Date()))}
            >
              {t.today}
            </button>
            <span className="gh-picker-footer-note" />
            {clearable && value && (
              <button
                type="button"
                className="gh-text-button"
                onClick={() => {
                  onChange('');
                  close();
                }}
              >
                {t.clear}
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

/** Start and end in one panel: the first pick sets the start, the second the end; hovering previews the range. */
export function DateRangePicker({
  label,
  start,
  end,
  onChange,
  placeholder,
  disabled = false,
  'aria-invalid': ariaInvalid,
  'aria-describedby': describedBy,
}: FieldProps & {
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
}) {
  const t = useKitStrings();
  const [open, setOpen] = useState(false);
  const [focus, setFocus] = useState(() => (start ? fromISO(start) : new Date()));
  const [anchor, setAnchor] = useState('');
  const [hover, setHover] = useState('');
  const trigger = useRef<HTMLButtonElement>(null);
  const { panel, style } = useFloating(open, { rect: () => trigger.current?.getBoundingClientRect() ?? null });
  const close = (restore = true) => {
    setOpen(false);
    setAnchor('');
    setHover('');
    if (restore) trigger.current?.focus({ preventScroll: true });
  };
  useDismiss(open, () => close(false), [panel, trigger]);
  const [from, to] = anchor ? [anchor, hover || anchor].sort() : [start, end];
  const text = start && end ? `${format(t, start)}${t.rangeSeparator}${format(t, end)}` : '';
  return (
    <span className="gh-date-picker">
      <DateTrigger
        label={label}
        text={text}
        placeholder={placeholder ?? t.chooseRange}
        open={open}
        disabled={disabled}
        invalid={invalid(ariaInvalid)}
        describedBy={describedBy}
        trigger={trigger}
        onToggle={() => {
          setFocus(start ? fromISO(start) : new Date());
          if (open) close();
          else setOpen(true);
        }}
      />
      {open && (
        <div ref={panel} role="dialog" aria-label={label} className="gh-picker-panel gh-calendar-panel" style={style}>
          <Calendar
            focus={focus}
            setFocus={(date) => {
              setFocus(date);
              if (anchor) setHover(toISO(date));
            }}
            isSelected={(iso) => iso === from || iso === to}
            inRange={(iso) => !!from && !!to && iso > from && iso < to}
            isDisabled={() => false}
            onHover={(iso) => anchor && setHover(iso)}
            onPick={(iso) => {
              if (!anchor) {
                setAnchor(iso);
                setHover(iso);
                return;
              }
              const [next, last] = [anchor, iso].sort();
              onChange(next, last);
              close();
            }}
            onClose={close}
          />
          <div className="gh-picker-footer">
            <span className="gh-picker-footer-note">{anchor ? t.pickEnd : t.pickStart}</span>
          </div>
        </div>
      )}
    </span>
  );
}
