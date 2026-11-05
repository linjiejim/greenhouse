import React, { useState } from 'react';
import { Overlay } from './overlay.web';
/** Tooltips stay inside the window: a long one wraps at TOOLTIP_MAX and shifts left near the edge. */
const TOOLTIP_MAX = 320;
const placeTip = (r: DOMRect) => ({
  x: Math.max(8, Math.min(r.left, window.innerWidth - Math.min(TOOLTIP_MAX, window.innerWidth - 16) - 8)),
  y: r.bottom + 4,
});
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
          panelStyle={{ maxWidth: Math.min(TOOLTIP_MAX, window.innerWidth - 16), whiteSpace: 'normal' }}
        >
          {label}
        </Overlay>
      ) : null}
    </span>
  );
}
