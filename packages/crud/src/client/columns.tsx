/** Column cell rendering for the list table. */

import React from 'react';
import { Badge, TagList } from '@greenhouse/ui/components/ui';

import type { ColumnDef } from './schema.js';
import { getCrudColumn } from './registry.js';
import { formatCell } from './util.js';

export function renderCell<TRow>(col: ColumnDef<TRow>, row: TRow): React.ReactNode {
  const record = row as Record<string, unknown>;

  if (col.type === 'custom') return col.render(row);
  if (col.type === 'extension') {
    const renderer = getCrudColumn(col.name);
    return renderer ? renderer({ value: record[col.key], row: record, config: col.config }) : '—';
  }

  const value = record[col.key];

  switch (col.type) {
    case 'badge': {
      const tone = col.badgeMap?.[String(value)] ?? 'default';
      if (value == null || value === '') return <span className="text-fg-faint">—</span>;
      return <Badge variant={tone}>{String(value)}</Badge>;
    }
    case 'tags': {
      const items = Array.isArray(value) ? (value as Array<string | number>) : [];
      if (items.length === 0) return <span className="text-fg-faint">—</span>;
      return <TagList items={items} />;
    }
    case 'boolean':
    case 'toggle':
      // Read-only rendering (detail view). The interactive switch lives in CrudPage.
      return value ? <Badge variant="success">✓</Badge> : <span className="text-fg-faint">—</span>;
    case 'longtext': {
      const text = value == null ? '' : String(value);
      const max = col.truncate ?? 80;
      return (
        <span className="text-fg-muted" title={text}>
          {text.length > max ? `${text.slice(0, max)}…` : text || '—'}
        </span>
      );
    }
    case 'number':
    case 'date':
    case 'datetime':
      return <span className="text-fg-secondary">{formatCell(col.type, value)}</span>;
    case 'text':
    default: {
      const text = formatCell('text', value);
      const max = 'truncate' in col ? col.truncate : undefined;
      if (max && text.length > max) {
        return (
          <span title={text} className="truncate inline-block max-w-full align-bottom">
            {text.slice(0, max)}…
          </span>
        );
      }
      return text;
    }
  }
}
