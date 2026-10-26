/** Same generated Haven geometry, with DOM accessibility attributes on SVG. */
import React, { useEffect } from 'react';
import { GREENHOUSE_PATHS } from './brand.generated';
import { useTheme } from '../theme';
export const MARK_BUILD_MS = 650;
export function GreenhouseMark({
  size = 72,
  color,
  animate = false,
  onBuilt,
}: {
  size?: number;
  color?: string;
  animate?: boolean;
  onBuilt?: () => void;
}) {
  const { hex } = useTheme();
  useEffect(() => {
    onBuilt?.();
  }, [onBuilt]);
  return (
    <svg
      role="img"
      aria-label="Greenhouse"
      viewBox="0 0 224 224"
      width={size}
      height={size}
      style={{ flexShrink: 0 }}
      data-animate={animate || undefined}
    >
      {GREENHOUSE_PATHS.map(({ id, d }) => (
        <path key={id} d={d} fill={color ?? (id === 'seed' ? hex.seed : hex.mark)} />
      ))}
    </svg>
  );
}
