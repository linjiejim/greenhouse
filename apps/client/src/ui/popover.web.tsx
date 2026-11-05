import React, { useState } from 'react';
import { Overlay } from './overlay.web';
/** A long tooltip wraps at TOOLTIP_MAX; the overlay keeps it inside the window at its rendered width. */
const TOOLTIP_MAX = 320;
const placeTip = (r: DOMRect) => ({ x: r.left, y: r.bottom + 4 });
export function Tooltip({ children, label }: { children: React.ReactNode; label: string }) {
  const [point, setPoint] = useState<{ x: number; y: number } | null>(null);
  return (
    <span
      onMouseEnter={(e) => setPoint(placeTip(e.currentTarget.getBoundingClientRect()))}
      onMouseLeave={() => setPoint(null)}
      onFocus={(e) => setPoint(placeTip(e.currentTarget.getBoundingClientRect()))}
      onBlur={() => setPoint(null)}
    >
      {children}
      {point ? (
        <Overlay
          role="tooltip"
          modal={false}
          point={point}
          onClose={() => setPoint(null)}
          // its own width (up to TOOLTIP_MAX) before the overlay measures and clamps it
          panelStyle={{ width: 'max-content', maxWidth: Math.min(TOOLTIP_MAX, window.innerWidth - 16), whiteSpace: 'normal' }}
        >
          {label}
        </Overlay>
      ) : null}
    </span>
  );
}
