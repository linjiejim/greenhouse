import React from 'react';
import { InlineEditCell } from '@greenhouse/web/extension-kit';
import type { TableField } from '../api';
import { parsePastedCell, type TablePasteUser } from './grid-utils';

interface InlineCellProps {
  field: TableField;
  value: unknown;
  users: TablePasteUser[];
  canEdit: boolean;
  children: React.ReactNode;
  onCommit: (value: unknown) => Promise<void>;
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
}

function draftValue(field: TableField, value: unknown): string {
  if (field.type === 'datetime' && typeof value === 'string') return value.slice(0, 16);
  if (Array.isArray(value)) return value.join(', ');
  return value === null || value === undefined ? '' : String(value);
}

export function InlineCell({ field, value, users, canEdit, children, onCommit, onPaste }: InlineCellProps) {
  const config = field.config ?? {};
  const selectOptions =
    field.type === 'single_select'
      ? (config.options ?? []).map((option) => ({ value: option.id, label: option.label }))
      : field.type === 'user'
        ? users.map((user) => ({ value: user.id, label: user.nickname }))
        : null;

  return (
    <InlineEditCell
      label={field.name}
      value={value}
      canEdit={canEdit}
      inputType={
        field.type === 'boolean'
          ? 'boolean'
          : selectOptions
            ? 'select'
            : field.type === 'number'
              ? 'number'
              : field.type === 'date'
                ? 'date'
                : field.type === 'datetime'
                  ? 'datetime-local'
                  : field.type === 'email'
                    ? 'email'
                    : field.type === 'url'
                      ? 'url'
                      : field.type === 'phone'
                        ? 'tel'
                        : 'text'
      }
      options={selectOptions ?? undefined}
      formatDraft={(nextValue) => draftValue(field, nextValue)}
      parseDraft={(nextDraft) => parsePastedCell(field, nextDraft, users)}
      onCommit={onCommit}
      onPaste={onPaste}
    >
      {children}
    </InlineEditCell>
  );
}
