/**
 * Pickers drawn in the Haven style instead of the browser's own: Select, MultiSelect,
 * DatePicker and DateRangePicker (docs/design-system/components.md, 输入).
 * Each trigger is as tall as an input, opens one floating panel, and works with the
 * keyboard alone. NativeSelect is only for the prototype's own preview controls.
 */

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useDismiss, useFloating } from './popover';

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
  useEffect(() => {
    document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [id, active]);
  return (
    <div role="listbox" id={id} aria-label={label} aria-multiselectable={multiple || undefined} className="picker-list">
      {items.map((item, index) => (
        <div
          key={item.value}
          id={`${id}-${index}`}
          role="option"
          aria-selected={isSelected(item)}
          aria-disabled={item.disabled || undefined}
          className={`picker-option ${index === active ? 'active' : ''}`}
          onPointerMove={() => !item.disabled && setActive(index)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => !item.disabled && onPick(item)}
        >
          {multiple && (
            <span className="check-box" aria-hidden>
              {isSelected(item) && <Check size={12} />}
            </span>
          )}
          {item.icon && <span className="picker-option-icon">{item.icon}</span>}
          <span className="picker-option-text">
            <span>{item.label}</span>
            {item.description && <span className="picker-option-description">{item.description}</span>}
          </span>
          {!multiple && isSelected(item) && <Check size={15} className="picker-check" />}
        </div>
      ))}
      {!items.length && <div className="picker-empty">没有匹配的选项</div>}
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
  return (
    <div className="picker-search">
      <Search size={14} />
      <input
        autoFocus
        aria-label="搜索选项"
        aria-controls={listId}
        aria-activedescendant={activeId}
        placeholder="搜索"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
    </div>
  );
}

const matches = (item: Item, query: string) =>
  !query || `${item.label} ${item.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase());

export function Select({
  label,
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled = false,
  invalid = false,
  searchable,
  size = 'md',
  className = '',
}: {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  searchable?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
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
    keys.setActive(Math.max(0, all.indexOf(selected!)));
    setOpen(true);
  };
  const typeahead = (key: string) => {
    const start = Math.max(0, all.indexOf(selected!));
    const next = [...all.slice(start + 1), ...all.slice(0, start + 1)].find(
      (item) => !item.disabled && item.label.toLowerCase().startsWith(key.toLowerCase()),
    );
    if (next) onChange(next.value);
  };
  return (
    <span className={`select ${size} ${className}`}>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !search && items[keys.active] ? `${listId}-${keys.active}` : undefined}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className="picker-trigger"
        // Enter and Space reach here as a click with detail 0: while open they pick the active option.
        onClick={(event) => {
          if (!open) show();
          else if (event.detail === 0 && items[keys.active] && !items[keys.active].disabled) pick(items[keys.active]);
          else close();
        }}
        onKeyDown={(event) => {
          if (open && !search) {
            if (event.key !== 'Enter' && event.key !== ' ') keys.onKeyDown(event);
          } else if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            event.preventDefault();
            show();
          } else if (!open && event.key.length === 1 && event.key !== ' ' && !event.metaKey && !event.ctrlKey)
            typeahead(event.key);
        }}
      >
        {selected?.icon}
        <span className={`picker-value ${selected ? '' : 'placeholder'}`}>{selected?.label ?? placeholder}</span>
        <ChevronDown size={14} className="picker-chevron" />
      </button>
      {open && (
        <div ref={panel} className="picker-panel" style={style}>
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

/** Several values, shown as chips. Enter or a click toggles; the list stays open. */
export function MultiSelect({
  label,
  value,
  options,
  onChange,
  placeholder = '请选择',
  disabled = false,
  max = 2,
}: {
  label: string;
  value: string[];
  options: readonly SelectOption[];
  onChange: (value: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  /** Chips shown before "+N". */
  max?: number;
}) {
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
    <span className="select multi">
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        disabled={disabled}
        className="picker-trigger"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => {
          if (!open && event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className={`picker-value chips ${chosen.length ? '' : 'placeholder'}`}>
          {chosen.length
            ? chosen.slice(0, max).map((item) => (
                <span key={item.value} className="chip">
                  {item.label}
                </span>
              ))
            : placeholder}
          {chosen.length > max && <span className="chip more">+{chosen.length - max}</span>}
        </span>
        <ChevronDown size={14} className="picker-chevron" />
      </button>
      {open && (
        <div ref={panel} className="picker-panel" style={style}>
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
          <div className="picker-footer">
            <span className="muted small grow">已选 {value.length}</span>
            <button type="button" className="text-button" disabled={!value.length} onClick={() => onChange([])}>
              清除
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

// ─── Dates ───

const pad = (value: number) => String(value).padStart(2, '0');
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
const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
/** Monday-first index. */
const weekday = (date: Date) => (date.getDay() + 6) % 7;

/** 10 月 16 日 周五 this year; 2025 年 10 月 3 日 otherwise (docs/design-system/content.md). */
export function formatDate(value: string) {
  if (!value) return '';
  const date = fromISO(value);
  return date.getFullYear() === new Date().getFullYear()
    ? `${date.getMonth() + 1} 月 ${date.getDate()} 日 周${WEEKDAYS[weekday(date)]}`
    : `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日`;
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
  const grid = useRef<HTMLDivElement>(null);
  const today = toISO(new Date());
  const first = new Date(focus.getFullYear(), focus.getMonth(), 1);
  const start = addDays(first, -weekday(first));
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
      Home: () => addDays(focus, -weekday(focus)),
      End: () => addDays(focus, 6 - weekday(focus)),
      PageUp: () => addMonths(focus, -1),
      PageDown: () => addMonths(focus, 1),
    };
    if (moves[event.key]) {
      event.preventDefault();
      setFocus(moves[event.key]());
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="calendar">
      <div className="calendar-header">
        <strong aria-live="polite">
          {focus.getFullYear()} 年 {focus.getMonth() + 1} 月
        </strong>
        <span className="grow" />
        <button
          type="button"
          className="calendar-nav"
          aria-label="上个月"
          onClick={() => setFocus(addMonths(focus, -1))}
        >
          <ChevronLeft size={16} />
        </button>
        <button
          type="button"
          className="calendar-nav"
          aria-label="下个月"
          onClick={() => setFocus(addMonths(focus, 1))}
        >
          <ChevronRight size={16} />
        </button>
      </div>
      <div
        className="calendar-grid"
        role="grid"
        aria-label={`${focus.getFullYear()} 年 ${focus.getMonth() + 1} 月`}
        ref={grid}
        onKeyDown={onKeyDown}
      >
        <div role="row" className="calendar-row">
          {WEEKDAYS.map((day) => (
            <span key={day} role="columnheader" className="calendar-weekday">
              {day}
            </span>
          ))}
        </div>
        {Array.from({ length: 6 }, (_, row) => (
          <div role="row" className="calendar-row" key={row}>
            {days.slice(row * 7, row * 7 + 7).map((day) => {
              const iso = toISO(day);
              const outside = day.getMonth() !== focus.getMonth();
              return (
                <span role="gridcell" key={iso} aria-selected={isSelected(iso)}>
                  <button
                    type="button"
                    data-date={iso}
                    tabIndex={iso === toISO(focus) ? 0 : -1}
                    disabled={isDisabled(iso)}
                    aria-label={`${day.getMonth() + 1} 月 ${day.getDate()} 日 星期${WEEKDAYS[weekday(day)]}`}
                    aria-current={iso === today ? 'date' : undefined}
                    className={`calendar-day ${outside ? 'outside' : ''} ${isSelected(iso) ? 'selected' : ''} ${inRange?.(iso) ? 'in-range' : ''}`}
                    onClick={() => onPick(iso)}
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
  invalid,
  onToggle,
  onClear,
  trigger,
}: {
  label: string;
  text: string;
  placeholder: string;
  open: boolean;
  disabled: boolean;
  invalid: boolean;
  onToggle: () => void;
  onClear?: () => void;
  trigger: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <span className="date-trigger">
      <button
        ref={trigger}
        type="button"
        aria-label={text ? `${label}：${text}` : label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        className="picker-trigger"
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            onToggle();
          }
        }}
      >
        <CalendarDays size={15} className="picker-leading" />
        <span className={`picker-value ${text ? '' : 'placeholder'}`}>{text || placeholder}</span>
      </button>
      {onClear && text && !disabled && (
        <button type="button" className="picker-clear" aria-label={`清除${label}`} onClick={onClear}>
          <X size={13} />
        </button>
      )}
    </span>
  );
}

export function DatePicker({
  label,
  value,
  onChange,
  placeholder = '选择日期',
  min,
  max,
  disabled = false,
  invalid = false,
  clearable = true,
}: {
  label: string;
  /** YYYY-MM-DD or ''. */
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  min?: string;
  max?: string;
  disabled?: boolean;
  invalid?: boolean;
  clearable?: boolean;
}) {
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
    <span className="date-picker">
      <DateTrigger
        label={label}
        text={formatDate(value)}
        placeholder={placeholder}
        open={open}
        disabled={disabled}
        invalid={invalid}
        trigger={trigger}
        onToggle={() => {
          setFocus(value ? fromISO(value) : new Date());
          setOpen(!open);
        }}
        onClear={clearable ? () => onChange('') : undefined}
      />
      {open && (
        <div ref={panel} role="dialog" aria-label={label} className="picker-panel calendar-panel" style={style}>
          <Calendar
            focus={focus}
            setFocus={setFocus}
            isSelected={(iso) => iso === value}
            isDisabled={isDisabled}
            onPick={pick}
            onClose={close}
          />
          <div className="picker-footer">
            <button
              type="button"
              className="text-button"
              disabled={isDisabled(toISO(new Date()))}
              onClick={() => pick(toISO(new Date()))}
            >
              今天
            </button>
            <span className="grow" />
            {clearable && value && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  onChange('');
                  close();
                }}
              >
                清除
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}

/** Start and end in one panel: the first click sets the start, the second the end. */
export function DateRangePicker({
  label,
  start,
  end,
  onChange,
  placeholder = '选择日期范围',
  disabled = false,
}: {
  label: string;
  start: string;
  end: string;
  onChange: (start: string, end: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
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
  const text = start && end ? `${formatDate(start)} – ${formatDate(end)}` : '';
  return (
    <span className="date-picker">
      <DateTrigger
        label={label}
        text={text}
        placeholder={placeholder}
        open={open}
        disabled={disabled}
        invalid={false}
        trigger={trigger}
        onToggle={() => {
          setFocus(start ? fromISO(start) : new Date());
          if (open) close();
          else setOpen(true);
        }}
      />
      {open && (
        <div ref={panel} role="dialog" aria-label={label} className="picker-panel calendar-panel" style={style}>
          <Calendar
            focus={focus}
            setFocus={setFocus}
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
          <div className="picker-footer">
            <span className="muted small">{anchor ? '再选结束日期' : '先选开始日期'}</span>
          </div>
        </div>
      )}
    </span>
  );
}

/** The prototype's own preview controls only; product UI uses Select. */
export function NativeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly string[];
  onChange: (value: string) => void;
}) {
  return (
    <span className="native-select">
      <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option}>{option}</option>
        ))}
      </select>
      <ChevronDown size={13} />
    </span>
  );
}
