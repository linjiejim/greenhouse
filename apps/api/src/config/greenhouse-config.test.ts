import { describe, expect, it } from 'vitest';
import { DEFAULT_GREENHOUSE_CONFIG } from '@greenhouse/types/config';
import { applyConfigEnv, GREENHOUSE_CONFIG, extensionEnabled } from './greenhouse-config.js';

describe('greenhouse.config.ts loader', () => {
  it('loads the repository config file with defaults filled in', () => {
    expect(GREENHOUSE_CONFIG.clients.stations.mode).toBe('multi');
    expect(Array.isArray(GREENHOUSE_CONFIG.packs.skills)).toBe(true);
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
