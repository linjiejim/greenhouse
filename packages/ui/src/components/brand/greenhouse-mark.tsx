import React from 'react';
import { GREENHOUSE_PATHS } from './paths.generated.js';

/** The product mark. Agent identity remains the separate PlantAvatar system. */
export function GreenhouseMark({
  label,
  className = '',
  animate = false,
  elapsed = 0,
}: {
  label?: string;
  className?: string;
  animate?: boolean;
  /** Continue the same launch animation when bootstrap hands off to auth. */
  elapsed?: number;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 224 224"
      className={`greenhouse-mark ${animate ? 'greenhouse-mark-intro' : ''} ${className}`}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ '--brand-intro-offset': `${-Math.max(0, elapsed)}ms` } as React.CSSProperties}
    >
      {GREENHOUSE_PATHS.map(({ id, d }) => (
        <path key={id} d={d} className={`greenhouse-${id}`} />
      ))}
      <path
        className="greenhouse-house-seal"
        d={GREENHOUSE_PATHS.filter(({ id }) => id !== 'seed')
          .map(({ d }) => d)
          .join(' ')}
      />
    </svg>
  );
}
