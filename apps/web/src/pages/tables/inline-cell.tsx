import React from 'react';
import { InlineEditCell } from '../../components/tables';
import { InlineFieldEditor, isInlineEditable } from '../../components/tables/field-editor';
import type { TableField, TableUserOption } from '../../lib/api/tables';

interface InlineCellProps {
  field: TableField;
  value: unknown;
  users: TableUserOption[];
  canEdit: boolean;
  children: React.ReactNode;
  onCommit: (value: unknown) => Promise<void>;
  onPaste: (event: React.ClipboardEvent<HTMLDivElement>) => void;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/** A grid cell: the shared inline-edit shell around the one Tables `FieldEditor`. */
export function InlineCell({ field, value, users, canEdit, children, onCommit, onPaste }: InlineCellProps) {
  return (
    <InlineEditCell<unknown>
      label={field.name}
      value={value}
      canEdit={canEdit && isInlineEditable(field)}
      onCommit={onCommit}
      onPaste={onPaste}
      renderEditor={({ commit, cancel, saving }) => (
        <InlineFieldEditor
          field={field}
          stored={value}
          users={users}
          saving={saving}
          onCommit={(next) => (sameValue(next, value) ? cancel() : commit(next))}
          onCancel={cancel}
        />
      )}
    >
      {children}
    </InlineEditCell>
  );
}
