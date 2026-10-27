/** Same readiness/deadline as native; CSS owns the web fade and its completion. */
import React, { useEffect, useRef, useState } from 'react';
import { GreenhouseMark } from './logo';
import { STARTUP_CONTENT_GRACE_MS } from '../startup/content';
import { useTheme } from '../theme';
export function Splash({ ready, contentReady, onGone }: { ready: boolean; contentReady: boolean; onGone: () => void }) {
  const { hex: c } = useTheme();
  const [expired, setExpired] = useState(false);
  const gone = useRef(onGone);
  gone.current = onGone;
  useEffect(() => {
    if (!ready) {
      setExpired(false);
      return;
    }
    const timer = setTimeout(() => setExpired(true), STARTUP_CONTENT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  const leave = ready && (contentReady || expired);
  useEffect(() => {
    if (!leave) return;
    // A bounded callback also works with reduced motion and background tabs.
    const timer = setTimeout(() => gone.current(), 160);
    return () => clearTimeout(timer);
  }, [leave]);
  return (
    <div
      data-testid="startup-splash"
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 2000,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: c.background,
        color: c.label,
        opacity: leave ? 0 : 1,
        transition: 'opacity 160ms',
        pointerEvents: 'auto',
      }}
    >
      <GreenhouseMark size={96} />
      <span>Greenhouse</span>
    </div>
  );
}
