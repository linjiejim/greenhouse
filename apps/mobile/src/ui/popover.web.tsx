import React, { useState } from 'react';
import { Overlay } from './overlay.web';
export function Popover({
  children,
  open,
  onClose,
  point,
  label,
}: {
  children: React.ReactNode;
  open: boolean;
  onClose: () => void;
  point?: { x: number; y: number };
  label?: string;
}) {
  return open ? (
    <Overlay label={label} modal={false} point={point} onClose={onClose}>
      {children}
    </Overlay>
  ) : null;
}
export function Tooltip({ children, label }: { children: React.ReactNode; label: string }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      onMouseEnter={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPoint({ x: r.left, y: r.bottom + 4 });
      }}
      onMouseLeave={() => setPoint(null)}
      onFocus={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setPoint({ x: r.left, y: r.bottom + 4 });
      }}
      onBlur={() => setPoint(null)}
      aria-label={label}
    >
      {children}
      {point ? (
        <Overlay role="tooltip" modal={false} point={point} onClose={() => setPoint(null)}>
          {label}
        </Overlay>
      ) : null}
    </span>
  );
}
