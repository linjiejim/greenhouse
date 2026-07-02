/**
 * Fork extension point for branding (S6) — the ONLY file a downstream fork
 * edits to rebrand the UI chrome (product name + logo mark).
 *
 * Upstream ships the Greenhouse defaults. The full branding surface for a fork:
 *   1. `PRODUCT_NAME` env — document title (build-time, see vite.config.ts) and
 *      the runtime default for `BRANDING.productName` below.
 *   2. This file — override `productName` / `Mark` for the in-app logo lockups.
 *   3. `src/branding.css` — design-token overrides (colors, radii). Generate the
 *      block with Settings → Branding Studio (super only) and paste it there.
 *   4. `public/favicon.*` / `apple-touch-icon.png` — replace the static assets.
 *
 * Fork example (in the fork's copy of this file):
 *   export const BRANDING: BrandingConfig = {
 *     productName: 'Acme Agent',
 *     Mark: AcmeMark,          // an SVG component drawn with `currentColor`
 *   };
 */

import React from 'react';

export interface BrandMarkProps {
  className?: string;
}

/** The Greenhouse logo mark — a line-art greenhouse with a seedling.
 *  Drawn with `currentColor`, so it inherits the surrounding text color
 *  (and therefore the primary brand color inside AppLogo). */
export function GreenhouseMark({ className }: BrandMarkProps) {
  return (
    <svg
      viewBox="9 7 112 112"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 104 L22 56 L65 22 L108 56 L108 104 Z" />
      <path d="M22 56 L108 56" />
      <path d="M44 56 L44 104" />
      <path d="M86 56 L86 104" />
      <path d="M65 104 L65 84" />
      <path d="M65 84 C69 78 74 75 76 65 C72 69 67 77 65 84 Z" />
      <path d="M65 84 C61 78 56 75 54 65 C58 69 63 77 65 84 Z" />
    </svg>
  );
}

export interface BrandingConfig {
  /** Product name shown in the UI (logo lockup, login screen, aria labels). */
  productName: string;
  /** Logo mark component — an SVG that inherits `currentColor`. */
  Mark: (props: BrandMarkProps) => React.ReactElement;
}

declare const __PRODUCT_NAME__: string;

/** Branding used by the app chrome. Greenhouse defaults upstream. */
export const BRANDING: BrandingConfig = {
  productName: typeof __PRODUCT_NAME__ !== 'undefined' ? __PRODUCT_NAME__ : 'Greenhouse',
  Mark: GreenhouseMark,
};
