/**
 * Drift guard for the generated API v2 contract. apps/mobile sits outside the pnpm workspace, so
 * src/shared/contract.ts spells out the types packages/contract infers with zod
 * (scripts/vendor-mobile-contract.ts writes it). If they differ, the phone reads a field the
 * server renamed or sends one it no longer takes. Fix by running the script again, never by
 * editing the copy.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { render, TARGET } from '../../../../scripts/vendor-mobile-contract';

describe('generated API contract', () => {
  it('matches what packages/contract infers today', { timeout: 60_000 }, async () => {
    expect(readFileSync(TARGET, 'utf8')).toBe(await render());
  });
});
