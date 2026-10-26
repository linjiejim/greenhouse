'use dom';
import React from 'react';
import { FieldValue, FieldTypeIcon } from '../../ui/field-value.web';
/** DOM grid consumes the shared table field formatter; native keeps its list. */
export default function TableGrid({
  columns,
  rows,
  onOpen,
  onContext,
  selected,
}: {
  columns: { id: string; name: string; kind: string }[];
  rows: { id: string; title: string; cells: string[] }[];
  onOpen: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
  selected?: string;
  dom?: import('expo/dom').DOMProps;
}) {
  return (
    <table className="gh-data-grid" role="grid">
      <colgroup>
        <col className="gh-row-number" />
        {columns.map((f) => (
          <col key={f.id} />
        ))}
      </colgroup>
      <thead>
        <tr role="row">
          <th scope="col">#</th>
          {columns.map((f) => (
            <th scope="col" key={f.id} className={f.kind === 'number' ? 'gh-number' : undefined}>
              <span className="gh-field-heading">
                <FieldTypeIcon kind={f.kind} />
                {f.name}
              </span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={r.id}
            role="row"
            tabIndex={0}
            aria-selected={selected === r.id}
            aria-label={r.title || r.cells.join(' · ')}
            onClick={() => onOpen(r.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              onContext(r.id, e.clientX, e.clientY);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onOpen(r.id);
              }
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const next =
                  e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
                (next as HTMLElement)?.focus();
              }
            }}
          >
            <td className="gh-row-number">{i + 1}</td>
            {r.cells.map((cell, index) => (
              <td key={columns[index].id} className={columns[index].kind === 'number' ? 'gh-number' : undefined}>
                <FieldValue kind={columns[index].kind} text={cell} />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
