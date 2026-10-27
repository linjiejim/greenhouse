import React from 'react';
import { Chip } from './chip';
import { Icon, type IconName } from './core';

/** Shared presentation for table cells and declarative entity fields. */
export function FieldValue({ kind, text }: { kind: string; text: string }) {
  if (['enum', 'single_select', 'multi_select'].includes(kind) && text && text !== '—')
    return (
      <span className="gh-field-chip">
        <Chip label={text} inline tone="accent" />
      </span>
    );
  return <span>{text || '—'}</span>;
}
export function FieldTypeIcon({ kind }: { kind: string }) {
  const icon: IconName = ['integer', 'number', 'money'].includes(kind)
    ? 'bar'
    : ['date', 'dateTime', 'datetime'].includes(kind)
      ? 'clock'
      : ['enum', 'single_select', 'multi_select'].includes(kind)
        ? 'chevD'
        : kind === 'boolean'
          ? 'checkCircle'
          : ['user', 'multi_user'].includes(kind)
            ? 'person'
            : kind === 'relation'
              ? 'link'
              : 'text';
  return <Icon name={icon} size={13} />;
}
