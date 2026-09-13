import React, { useEffect, useRef, useState } from 'react';
import { Pencil } from '../../lib/icons';
import { Checkbox, Input, Select, Toggle } from '../ui';
import { InlineMultiSelectEditor } from './inline-multi-select-editor';
import { useT } from '../../lib/i18n';

export type InlineEditInputType =
  | 'text'
  | 'number'
  | 'email'
  | 'url'
  | 'tel'
  | 'date'
  | 'datetime-local'
  | 'select'
  | 'multi-select'
  | 'boolean';

export interface InlineEditOption {
  value: string;
  label: string;
}

interface InlineEditCellProps<T> {
  label: string;
  value: T;
  children: React.ReactNode;
  onCommit: (value: T) => Promise<void>;
  inputType?: InlineEditInputType;
  options?: InlineEditOption[];
  canEdit?: boolean;
  emptyOptionLabel?: string;
  allowCustomOptions?: boolean;
  quickToggle?: boolean;
  formatDraft?: (value: T) => string;
  parseDraft?: (draft: string) => T;
  onPaste?: (event: React.ClipboardEvent<HTMLDivElement>) => void;
  className?: string;
}

function defaultDraftValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  return value === null || value === undefined ? '' : String(value);
}

/**
 * Shared table-cell editor used by Tables and domain grids.
 *
 * Editing starts from the pencil that appears on hover (or Enter/F2 when the
 * cell has focus); Enter/blur saves and Escape cancels. A plain click is *not*
 * an edit — it falls through to the row, which is what opens the record.
 *
 * That fall-through is the whole design: this used to enter edit mode on
 * double-click, which forced editable cells to swallow single clicks so the
 * two could be told apart without a timer. The cost was that clicking a cell
 * to look at a row silently did nothing across every grid in the app.
 */
export function InlineEditCell<T>({
  label,
  value,
  children,
  onCommit,
  inputType = 'text',
  options = [],
  canEdit = true,
  emptyOptionLabel = '—',
  allowCustomOptions = false,
  quickToggle = false,
  formatDraft = defaultDraftValue,
  parseDraft = (draft) => draft as T,
  onPaste,
  className = '',
}: InlineEditCellProps<T>) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => formatDraft(value));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const cancelledRef = useRef(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!editing) setDraft(formatDraft(value));
  }, [editing, formatDraft, value]);

  useEffect(() => {
    if (!canEdit) setEditing(false);
  }, [canEdit]);

  const beginEditing = () => {
    if (!canEdit) return;
    cancelledRef.current = false;
    setError('');
    setDraft(formatDraft(value));
    setEditing(true);
  };

  const cancelEditing = () => {
    cancelledRef.current = true;
    setError('');
    setDraft(formatDraft(value));
    setEditing(false);
  };

  const commitValue = async (nextValue: T) => {
    if (savingRef.current || cancelledRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      if (Object.is(nextValue, value)) {
        setEditing(false);
        return;
      }
      await onCommit(nextValue);
      setEditing(false);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.saveCellFailed'));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const commit = async (nextDraft = draft) => {
    try {
      await commitValue(parseDraft(nextDraft));
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : 'Unable to parse cell value');
    }
  };

  if (!editing && canEdit && inputType === 'boolean' && quickToggle) {
    return (
      <div
        className={`flex min-h-6 items-center gap-2 px-1 py-0.5 ${className}`}
        title={error || undefined}
        aria-busy={saving}
        onClick={(event) => event.stopPropagation()}
      >
        <Toggle
          label={label}
          size="sm"
          checked={value === true}
          disabled={saving}
          onChange={(checked) => void commitValue(checked as T)}
        />
        <span className="text-xs text-fg-muted">{value === true ? t('common.yes') : t('common.no')}</span>
        {error && <span className="text-[10px] text-danger">{error}</span>}
      </div>
    );
  }

  if (!editing || !canEdit) {
    if (!canEdit) {
      return (
        <div className={`min-h-6 truncate rounded px-1 py-0.5 ${className}`} onPaste={onPaste}>
          {children}
        </div>
      );
    }
    return (
      <div
        tabIndex={0}
        aria-label={t('tables.editFieldLabel', { label })}
        title={t('tables.inlineEditHint')}
        className={`group/cell relative flex min-h-6 items-center gap-1 rounded px-1 py-0.5 outline-none focus:ring-2 focus:ring-primary-500/40 ${className}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === 'F2') {
            event.preventDefault();
            event.stopPropagation();
            beginEditing();
          }
        }}
        onPaste={onPaste}
      >
        <div className="min-w-0 flex-1 truncate">{children}</div>
        {/*
         * Hidden until hover/focus, but `touch-visible` keeps it on touch
         * devices, where hover never happens and this is the only way in.
         */}
        <button
          type="button"
          aria-label={t('tables.editFieldLabel', { label })}
          title={t('tables.editFieldLabel', { label })}
          className="flex-shrink-0 rounded p-0.5 text-fg-faint opacity-0 transition-opacity hover:bg-surface-muted hover:text-fg group-hover/cell:opacity-100 focus:opacity-100 focus-visible:opacity-100 touch-visible"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            beginEditing();
          }}
        >
          <Pencil size={11} />
        </button>
      </div>
    );
  }

  if (inputType === 'boolean') {
    return (
      <div className={className} title={error || undefined} onClick={(event) => event.stopPropagation()}>
        <div className="flex min-h-7 items-center gap-2 px-1 text-xs">
          <Checkbox
            autoFocus
            aria-label={label}
            checked={value === true}
            disabled={saving}
            onBlur={() => {
              if (!savingRef.current) setEditing(false);
            }}
            onChange={(event) => {
              savingRef.current = true;
              setSaving(true);
              setError('');
              void onCommit(event.target.checked as T)
                .then(() => setEditing(false))
                .catch((saveError: unknown) => {
                  setError(saveError instanceof Error ? saveError.message : t('tables.saveCellFailed'));
                })
                .finally(() => {
                  savingRef.current = false;
                  setSaving(false);
                });
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') cancelEditing();
            }}
          />
          <span>{value === true ? t('common.yes') : t('common.no')}</span>
        </div>
        {error && <p className="mt-1 whitespace-normal text-[10px] text-danger">{error}</p>}
      </div>
    );
  }

  if (inputType === 'multi-select') {
    return (
      <div className={`relative min-w-36 ${className}`} aria-busy={saving}>
        <InlineMultiSelectEditor
          label={label}
          selected={Array.isArray(value) ? value.map(String) : []}
          options={options}
          allowCustomOptions={allowCustomOptions}
          saving={saving}
          error={error}
          onCancel={cancelEditing}
          onApply={(selected) => void commitValue(selected as T)}
        />
      </div>
    );
  }

  const commonKeyDown = (event: React.KeyboardEvent<HTMLInputElement | HTMLSelectElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditing();
    } else if (event.key === 'Enter' && inputType !== 'select') {
      event.preventDefault();
      void commit();
    }
  };

  const control =
    inputType === 'select' ? (
      <Select
        autoFocus
        size="sm"
        aria-label={label}
        value={draft}
        disabled={saving}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          const nextDraft = event.target.value;
          setDraft(nextDraft);
          void commit(nextDraft);
        }}
        onBlur={() => {
          if (!savingRef.current) setEditing(false);
        }}
        onKeyDown={commonKeyDown}
      >
        <option value="">{emptyOptionLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </Select>
    ) : (
      <Input
        autoFocus
        size="sm"
        aria-label={label}
        type={inputType}
        step={inputType === 'number' ? 'any' : undefined}
        value={draft}
        disabled={saving}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!cancelledRef.current) void commit();
        }}
        onKeyDown={commonKeyDown}
      />
    );

  return (
    <div
      className={`min-w-36 ${className}`}
      title={error || undefined}
      aria-busy={saving}
      onClick={(event) => event.stopPropagation()}
    >
      {control}
      {error && <p className="mt-1 whitespace-normal text-[10px] text-danger">{error}</p>}
    </div>
  );
}
