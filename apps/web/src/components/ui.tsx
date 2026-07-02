/**
 * UI primitives — moved to @greenhouse/ui (shared UI kit); this shim keeps the
 * old import path working. Only <AppLogo> stays here, because it renders the
 * branding fork seam (S6, lib/branding.extensions.tsx) which is app-level.
 */

import React from 'react';
import { APP_VERSION } from '../lib/utils';
import { BRANDING } from '../lib/branding.extensions';

export * from '@greenhouse/ui/components/ui';

// ─── AppLogo ─────────────────────────────────────────────
// Logo mark + product name come from the branding seam (S6) — see
// lib/branding.extensions.tsx. Forks rebrand there, not here.

export function AppLogo({
  size = 'md',
  showVersion = false,
  logoOnly = false,
}: {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showVersion?: boolean;
  logoOnly?: boolean;
}) {
  const sizeClasses = { sm: 'w-6 h-6', md: 'w-8 h-8', lg: 'w-10 h-10', xl: 'w-16 h-16' };
  const iconSizeClasses = { sm: 'w-4 h-4', md: 'w-5 h-5', lg: 'w-6 h-6', xl: 'w-9 h-9' };
  const logoRounding = size === 'xl' ? 'rounded-xl' : 'rounded-lg';
  const mark = (
    <div
      className={`${sizeClasses[size]} ${logoRounding} flex items-center justify-center bg-primary-subtle text-primary-fg-strong`}
      aria-label={BRANDING.productName}
    >
      <BRANDING.Mark className={iconSizeClasses[size]} />
    </div>
  );
  if (logoOnly) {
    return mark;
  }
  return (
    <div className="flex items-center gap-2">
      {mark}
      <div className="flex flex-col">
        <span className="font-semibold text-fg text-sm leading-tight">{BRANDING.productName}</span>
        {showVersion && <span className="text-[9px] text-fg-faint font-mono leading-tight">v{APP_VERSION}</span>}
      </div>
    </div>
  );
}
