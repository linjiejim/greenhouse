import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Input, Tag } from '../ui';
import { X } from '../../lib/icons';
import type { InlineEditOption } from './inline-edit-cell';
import { useT } from '../../lib/i18n';

interface InlineMultiSelectEditorProps {
  label: string;
  selected: string[];
  options: InlineEditOption[];
  allowCustomOptions: boolean;
  saving: boolean;
  error: string;
  onApply: (selected: string[]) => void;
  onCancel: () => void;
}

export function InlineMultiSelectEditor({
  label,
  selected: initialSelected,
  options,
  allowCustomOptions,
  saving,
  error,
  onApply,
  onCancel,
}: InlineMultiSelectEditorProps) {
  const t = useT();
  const [selected, setSelected] = useState(initialSelected);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onCancel();
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [onCancel]);

  const normalizedOptions = useMemo(() => {
    const byValue = new Map(options.map((option) => [option.value, option]));
    for (const value of selected) {
      if (!byValue.has(value)) byValue.set(value, { value, label: value });
    }
    return [...byValue.values()];
  }, [options, selected]);

  const filteredOptions = normalizedOptions.filter((option) =>
    option.label.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
  );

  const toggle = (value: string) => {
    setSelected((current) =>
      current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value],
    );
  };

  const addCustomOption = () => {
    const value = query.trim();
    if (!allowCustomOptions || !value) return;
    setSelected((current) => (current.includes(value) ? current : [...current, value]));
    setQuery('');
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={label}
      className="absolute left-0 top-0 z-30 w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-edge bg-surface-raised p-2 shadow-xl"
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="mb-2 flex min-h-6 flex-wrap gap-1">
        {selected.length === 0 ? (
          <span className="text-xs text-fg-faint">—</span>
        ) : (
          selected.map((value) => (
            <Tag key={value} tone="primary" size="xs">
              {normalizedOptions.find((option) => option.value === value)?.label ?? value}
              <button
                type="button"
                aria-label={`Remove ${value}`}
                className="rounded hover:text-danger"
                onClick={() => toggle(value)}
              >
                <X size={10} />
              </button>
            </Tag>
          ))
        )}
      </div>
      <Input
        autoFocus
        size="xs"
        value={query}
        aria-label={`Search ${label}`}
        placeholder={allowCustomOptions ? 'Search or add…' : 'Search…'}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && allowCustomOptions) {
            event.preventDefault();
            addCustomOption();
          }
        }}
      />
      <div className="my-2 max-h-40 overflow-y-auto rounded border border-edge">
        {filteredOptions.map((option) => {
          const checked = selected.includes(option.value);
          return (
            <button
              key={option.value}
              type="button"
              role="checkbox"
              aria-checked={checked}
              className={`flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-surface-muted ${
                checked ? 'font-medium text-primary-fg-strong' : 'text-fg-secondary'
              }`}
              onClick={() => toggle(option.value)}
            >
              <span
                className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded border ${
                  checked ? 'border-primary-600 bg-primary-600 text-white' : 'border-edge-strong'
                }`}
              >
                {checked ? '✓' : ''}
              </span>
              <span className="truncate">{option.label}</span>
            </button>
          );
        })}
        {filteredOptions.length === 0 && (
          <div className="px-2 py-3 text-center text-xs text-fg-faint">
            {t(allowCustomOptions && query.trim() ? 'common.pressEnterToAdd' : 'common.noOptions')}
          </div>
        )}
      </div>
      {error && <p className="mb-2 text-[10px] text-danger">{error}</p>}
      <div className="flex justify-end gap-1">
        <Button type="button" size="sm" variant="ghost" disabled={saving} onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="button" size="sm" disabled={saving} onClick={() => onApply(selected)}>
          {saving ? t('common.saving') : t('common.save')}
        </Button>
      </div>
    </div>
  );
}
