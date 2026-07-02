/**
 * DataTableBlock — sortable, filterable data table rendered from custom code fence.
 *
 * Features:
 * - Click column headers to sort (asc → desc → none)
 * - Search box for full-text filtering
 * - Column type-aware formatting (number, currency, percent, boolean, badge)
 */

import React, { useState, useMemo } from 'react';
import { Input, SearchInput } from '../ui';
import type { DataTableData } from './index';
import { useT } from '../../lib/i18n';
import { BADGE_PALETTE } from '../../lib/utils';

// ─── Colors for badges ──────────────────────────────────
// Deterministically map each distinct value to a color from the shared
// BADGE_PALETTE (single source of truth — see lib/utils.ts).

function getBadgeColor(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return BADGE_PALETTE[Math.abs(hash) % BADGE_PALETTE.length];
}

// ─── Cell Formatting ─────────────────────────────────────

function formatCell(value: unknown, type?: string): React.ReactNode {
  if (value == null) return <span className="text-fg-faint">—</span>;

  switch (type) {
    case 'number':
      return typeof value === 'number' ? value.toLocaleString() : String(value);

    case 'currency':
      return typeof value === 'number'
        ? `$${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`
        : String(value);

    case 'percent': {
      const num = typeof value === 'number' ? value : parseFloat(String(value));
      if (isNaN(num)) return String(value);
      const pct = (num * 100).toFixed(1);
      const isPositive = num > 0;
      const isNegative = num < 0;
      return (
        <span className={isPositive ? 'text-success' : isNegative ? 'text-danger' : 'text-fg-secondary'}>
          {isPositive ? '+' : ''}
          {pct}%
        </span>
      );
    }

    case 'boolean':
      return value ? <span className="text-success font-medium">Yes</span> : <span className="text-fg-faint">No</span>;

    case 'badge': {
      const str = String(value);
      return (
        <span className={`inline-block px-2 py-0.5 text-[11px] font-medium rounded-full border ${getBadgeColor(str)}`}>
          {str}
        </span>
      );
    }

    default:
      return String(value);
  }
}

// ─── Sort helpers ────────────────────────────────────────

type SortDir = 'asc' | 'desc' | null;

function getSortValue(value: unknown, type?: string): number | string {
  if (value == null) return '';
  switch (type) {
    case 'number':
    case 'currency':
    case 'percent':
      return typeof value === 'number' ? value : parseFloat(String(value)) || 0;
    case 'boolean':
      return value ? 1 : 0;
    default:
      return String(value).toLowerCase();
  }
}

// ─── Component ───────────────────────────────────────────

export function DataTableBlock({ data }: { data: DataTableData }) {
  const t = useT();
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [search, setSearch] = useState('');

  const handleSort = (key: string) => {
    if (sortKey === key) {
      // Cycle: asc → desc → none
      if (sortDir === 'asc') setSortDir('desc');
      else if (sortDir === 'desc') {
        setSortKey(null);
        setSortDir(null);
      }
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const filteredRows = useMemo(() => {
    let rows = data.rows;

    // Search filter
    if (search.trim()) {
      const q = search.toLowerCase();
      rows = rows.filter((row) =>
        data.columns.some((col) => {
          const val = row[col.key];
          return val != null && String(val).toLowerCase().includes(q);
        }),
      );
    }

    // Sort
    if (sortKey && sortDir) {
      const col = data.columns.find((c) => c.key === sortKey);
      rows = [...rows].sort((a, b) => {
        const va = getSortValue(a[sortKey], col?.type);
        const vb = getSortValue(b[sortKey], col?.type);
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return rows;
  }, [data.rows, data.columns, search, sortKey, sortDir]);

  const sortIndicator = (key: string) => {
    if (sortKey !== key) return <span className="text-fg-faint ml-0.5">↕</span>;
    return <span className="text-primary-500 ml-0.5">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  return (
    <div className="my-3 border border-edge rounded-lg overflow-hidden bg-surface-raised">
      {/* Header bar */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface-sunken border-b border-edge">
        <div className="flex items-center gap-2">
          {data.title && <span className="text-xs font-semibold text-fg-secondary">{data.title}</span>}
          <span className="text-[10px] text-fg-faint">
            {filteredRows.length} row{filteredRows.length !== 1 ? 's' : ''}
          </span>
        </div>
        <SearchInput value={search} onChange={setSearch} placeholder="Search..." size="sm" className="w-32" />
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-surface-sunken/60">
              {data.columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => handleSort(col.key)}
                  className="px-3 py-2 text-left font-semibold text-fg-secondary cursor-pointer hover:bg-surface-muted transition-colors select-none whitespace-nowrap"
                >
                  {col.label}
                  {sortIndicator(col.key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {filteredRows.map((row, i) => (
              <tr key={i} className="hover:bg-surface-sunken/60 transition-colors">
                {data.columns.map((col) => (
                  <td key={col.key} className="px-3 py-2 text-fg-secondary whitespace-nowrap">
                    {formatCell(row[col.key], col.type)}
                  </td>
                ))}
              </tr>
            ))}
            {filteredRows.length === 0 && (
              <tr>
                <td colSpan={data.columns.length} className="px-3 py-6 text-center text-fg-faint">
                  {search ? t('common.noMatchingRows') : t('common.noData')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
