/**
 * GUARD TEST — the system-profile fork extension point (profiles/extensions.ts).
 *
 * The open-source release must ship ONLY the core profiles; a fork adds private
 * profiles via EXTENSION_SYSTEM_PROFILES without editing profile.ts. Pins the
 * empty upstream invariant + that the core profiles still load.
 */

import { describe, it, expect } from 'vitest';
import { EXTENSION_SYSTEM_PROFILES } from '../profiles/extensions.js';
import { listProfileIds, loadAllProfiles } from '../profile.js';

describe('system-profile extension seam', () => {
  it('ships only core profiles upstream (OSS invariant)', () => {
    expect(EXTENSION_SYSTEM_PROFILES).toEqual([]);
    expect(listProfileIds().sort()).toEqual(['default', 'team']);
    expect(loadAllProfiles().every((p) => Boolean(p.id) && Boolean(p.system_prompt))).toBe(true);
  });
});
