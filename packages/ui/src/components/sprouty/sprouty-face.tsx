/**
 * SproutyFace — the flat-SVG Sprouty mascot (identity avatar + agent states).
 *
 * Use for profile/identity avatars (with color/accessories/leafStyle), agent
 * lifecycle indicators (thinking / responding / done / error), and transient
 * emotional moments (love, cheer, sleep, surprise). Resolution-independent,
 * tiny, CSS-animated, reduced-motion aware. Pass `expr` for a specific face, or
 * `state` to map an agent lifecycle state to the fitting one.
 */

import React, { useMemo } from 'react';
import {
  SPROUTY_SIZES,
  type SproutyPalette,
  type SproutySize,
  type SproutyState,
  type SproutyVariant,
} from './sprouty-constants.js';
import {
  buildSproutyFaceSvg,
  ensureSproutyFaceStyles,
  FACE_STATE_MAP,
  type SproutyFaceExpr,
} from './sprouty-face-svg.js';

export type { SproutyFaceExpr } from './sprouty-face-svg.js';

export interface SproutyFaceProps {
  /** Explicit expression (wins over `state`). */
  expr?: SproutyFaceExpr;
  /** Agent lifecycle state, mapped to an expression via FACE_STATE_MAP. */
  state?: SproutyState;
  /** Color preset name from COLOR_PRESETS (undefined/'forest' = default green). */
  color?: string;
  /** Accessory ids: hats, glasses, held items. */
  accessories?: string[];
  /** Leaf style: 'normal' | 'big' | 'mini' | 'double'. */
  leafStyle?: string;
  /** Face style: 'default' | 'happy' | 'sparkle' | 'sleepy' (see FACE_STYLES). */
  faceStyle?: string;
  /** Free body/leaf hex override — wins over the `color` preset. */
  palette?: SproutyPalette;
  /** Accepted for drop-in compat with profileToSprouty; color drives the look. */
  variant?: SproutyVariant;
  /** Rendered size — px number, or a size preset ('sm', 'md'…). Default 40. */
  size?: number | SproutySize;
  /** Play animations. Default true. */
  animate?: boolean;
  className?: string;
  title?: string;
}

export function SproutyFace({
  expr,
  state,
  color,
  accessories,
  leafStyle,
  faceStyle,
  palette,
  variant: _variant,
  size = 40,
  animate = true,
  className = '',
  title,
}: SproutyFaceProps) {
  ensureSproutyFaceStyles();
  const px = typeof size === 'number' ? size : SPROUTY_SIZES[size];
  const resolved: SproutyFaceExpr = expr ?? (state ? FACE_STATE_MAP[state] : 'idle');
  const accKey = accessories?.join('|') ?? '';
  const paletteKey = palette ? `${palette.body ?? ''}|${palette.leaf ?? ''}` : '';
  const html = useMemo(
    () => buildSproutyFaceSvg(resolved, { animate, color, accessories, leafStyle, faceStyle, palette }),
    // accKey / paletteKey stand in for the array/object identities
    [resolved, animate, color, accKey, leafStyle, faceStyle, paletteKey], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <span
      className={`sf-root ${className}`}
      style={{ width: px, height: px }}
      role="img"
      aria-label={title ?? `Sprouty ${resolved}`}
      title={title}
      // Static, self-generated SVG string — no user input, safe to inject.
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
