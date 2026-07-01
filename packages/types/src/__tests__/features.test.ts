/**
 * GUARD + BEHAVIOR TEST — the feature-flag fork extension point.
 *
 * Upstream exposes ONLY the core flags; a fork-registered flag resolves through
 * getFeatureFlag / featureDefault / getAllFeatureFlags without editing the const
 * FEATURE_FLAGS array (which stays the compile-time FeatureKey source).
 */

import { describe, it, expect } from 'vitest';
import {
  FEATURE_FLAGS,
  getAllFeatureFlags,
  registerFeatureFlags,
  getFeatureFlag,
  featureDefault,
} from '../features.js';

describe('feature flag extension seam', () => {
  it('exposes only core flags upstream (OSS invariant)', () => {
    expect(getAllFeatureFlags()).toEqual(FEATURE_FLAGS);
  });

  it('a fork-registered flag resolves via getFeatureFlag / featureDefault', () => {
    registerFeatureFlags([{ key: 'crm-test', label: 'CRM', description: 'x', defaultEnabled: true }]);
    expect(getAllFeatureFlags().some((f) => f.key === 'crm-test')).toBe(true);
    expect(getFeatureFlag('crm-test')?.label).toBe('CRM');
    expect(featureDefault('crm-test')).toBe(true);
    // A core flag still resolves; unknown key still defaults false.
    expect(getFeatureFlag('memory')?.key).toBe('memory');
    expect(featureDefault('nope')).toBe(false);
  });
});
