'use dom';
import React from 'react';
/** DOM grid consumes the shared table field formatter; native keeps its list. */
export default function TableGrid({
  columns,
  rows,
  onOpen,
  onContext,
  labels,
}: {
  columns: { id: string; name: string }[];
  rows: { id: string; cells: string[] }[];
  onOpen: (id: string) => void;
  onContext: (id: string, x: number, y: number) => void;
  labels: { open: string };
  dom?: import('expo/dom').DOMProps;
}) {
  return (
    <table className="gh-data-grid" role="grid">
      <thead>
        <tr>
          <th>#</th>
          {columns.map((f) => (
            <th key={f.id}>{f.name}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr
            key={r.id}
            tabIndex={0}
            aria-label={`${labels.open} ${r.cells[0] || i + 1}`}
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
            <td>{rows.length - i}</td>
            {r.cells.map((cell, index) => (
              <td key={columns[index].id}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
