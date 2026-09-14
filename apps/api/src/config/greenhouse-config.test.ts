import { describe, expect, it } from 'vitest';
import { DEFAULT_GREENHOUSE_CONFIG } from '@greenhouse/types/config';
import { applyConfigEnv, GREENHOUSE_CONFIG, extensionEnabled } from './greenhouse-config.js';

describe('greenhouse.config.ts loader', () => {
  it('loads the repository config file with defaults filled in', () => {
    // Shape, not content: a fork ships its own greenhouse.config.ts, and a test
    // that pinned this repository's values would fail in every one of them.
    expect(['multi', 'single']).toContain(GREENHOUSE_CONFIG.clients.stations.mode);
    if (GREENHOUSE_CONFIG.clients.stations.mode === 'single') {
      expect(GREENHOUSE_CONFIG.clients.stations.defaults).toHaveLength(1);
    }
    expect(Array.isArray(GREENHOUSE_CONFIG.packs.skills)).toBe(true);
    expect(Array.isArray(GREENHOUSE_CONFIG.packs.profiles)).toBe(true);
    expect(typeof extensionEnabled('anything')).toBe('boolean');
  });

  it('lets GREENHOUSE_EXTENSIONS override the file', () => {
    const base = { ...DEFAULT_GREENHOUSE_CONFIG, extensions: { enabled: [] as string[] } };
    expect(applyConfigEnv(base, {}).extensions.enabled).toEqual([]);
    expect(applyConfigEnv(base, { GREENHOUSE_EXTENSIONS: 'all' }).extensions.enabled).toBe('all');
    expect(applyConfigEnv(base, { GREENHOUSE_EXTENSIONS: 'crm,example' }).extensions.enabled).toEqual([
      'crm',
      'example',
    ]);
    expect(applyConfigEnv(base, { GREENHOUSE_EXTENSIONS: '' }).extensions.enabled).toEqual([]);
  });
});
