/**
 * GUARD TEST — the branding fork seam (S6).
 *
 * Upstream ships the Greenhouse defaults: BRANDING must stay the stock
 * name/mark and branding.css must stay comment-only, so an open-source build
 * never carries downstream branding.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BRANDING, GreenhouseMark } from './branding.extensions';

describe('branding seam — Greenhouse defaults upstream (OSS invariant)', () => {
  it('ships the stock product name and logo mark', () => {
    // __PRODUCT_NAME__ is a Vite define — absent under vitest, so the fallback applies.
    expect(BRANDING.productName).toBe('Greenhouse');
    expect(BRANDING.Mark).toBe(GreenhouseMark);
  });

  it('branding.css is comment-only (no token overrides)', () => {
    const cssPath = fileURLToPath(new URL('../branding.css', import.meta.url));
    const css = readFileSync(cssPath, 'utf-8');
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
    expect(withoutComments).toBe('');
  });
});
