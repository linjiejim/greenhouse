/**
 * The Greenhouse mark on cold start and sign-in, with V2's one-shot Haven intro: the two halves
 * close in, then the seed grows (about 1.3 s, once per page load; static with Reduce Motion — the
 * CSS in packages/ui/src/styles/brand.css only animates under `prefers-reduced-motion:
 * no-preference`). The loading screen and the login screen share one clock, so when bootstrap
 * hands off to sign-in the animation continues instead of restarting. A workspace logo from
 * Branding Studio replaces the mark and never animates.
 */

import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { getRuntimeLogo, getRuntimeProductName } from '../../lib/workspace-branding';

/** How long the intro runs (the seed lands at ~1270 ms). */
export const BRAND_INTRO_MS = 1300;

let introStartedAt: number | null = null;

/** Where the intro is now: animate with `elapsed` while it runs, static afterwards. */
export function brandIntroClock(now = performance.now()): { animate: boolean; elapsed: number } {
  if (introStartedAt === null) introStartedAt = now;
  const elapsed = now - introStartedAt;
  return elapsed < BRAND_INTRO_MS ? { animate: true, elapsed } : { animate: false, elapsed: 0 };
}

/** Test seam: forget that the intro has played. */
export function resetBrandIntroForTests(): void {
  introStartedAt = null;
}

export function BrandIntro({ className = 'h-16 w-16' }: { className?: string }) {
  const logo = getRuntimeLogo();
  const name = getRuntimeProductName();
  if (logo) return <img src={logo} alt={name} className={`${className} rounded-lg object-contain`} />;
  const { animate, elapsed } = brandIntroClock();
  return <GreenhouseMark label={name} className={className} animate={animate} elapsed={elapsed} />;
}
