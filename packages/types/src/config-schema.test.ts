import { describe, expect, it } from 'vitest';
import { parseGreenhouseConfig } from './config-schema.js';
import { isExtensionEnabled, parseExtensionsEnv } from './config.js';

describe('parseGreenhouseConfig', () => {
  it('fills defaults for an empty file', () => {
    expect(parseGreenhouseConfig({})).toEqual({
      extensions: { enabled: 'all' },
      packs: { skills: [], profiles: [] },
      clients: { stations: { mode: 'multi', defaults: [] } },
    });
    expect(parseGreenhouseConfig(undefined).extensions.enabled).toBe('all');
  });

  it('keeps explicit values and merges partial sections', () => {
    const config = parseGreenhouseConfig({
      extensions: { enabled: ['crm'] },
      packs: { skills: ['../packs/skills'] },
      clients: { stations: { mode: 'single', defaults: [{ id: 'hq', name: 'HQ', url: 'https://gh.example.com' }] } },
    });
    expect(config.extensions.enabled).toEqual(['crm']);
    expect(config.packs).toEqual({ skills: ['../packs/skills'], profiles: [] });
    expect(config.clients.stations.mode).toBe('single');
  });

  it('rejects a single-station build without exactly one default', () => {
    expect(() => parseGreenhouseConfig({ clients: { stations: { mode: 'single' } } })).toThrow(/exactly one entry/);
    expect(() =>
      parseGreenhouseConfig({
        clients: {
          stations: {
            mode: 'single',
            defaults: [
              { id: 'a', name: 'A', url: 'https://a.example' },
              { id: 'b', name: 'B', url: 'https://b.example' },
            ],
          },
        },
      }),
    ).toThrow(/exactly one entry/);
  });

  it('rejects malformed station ids and urls with a readable message', () => {
    expect(() =>
      parseGreenhouseConfig({ clients: { stations: { defaults: [{ id: 'Bad Id', name: 'x', url: 'nope' }] } } }),
    ).toThrow(/Invalid greenhouse.config.ts/);
  });
});

describe('extension enable helpers', () => {
  it('parses the env override', () => {
    expect(parseExtensionsEnv(undefined)).toBeUndefined();
    expect(parseExtensionsEnv('all')).toBe('all');
    expect(parseExtensionsEnv('')).toEqual([]);
    expect(parseExtensionsEnv(' crm, drive ,')).toEqual(['crm', 'drive']);
  });

  it('answers isExtensionEnabled for both shapes', () => {
    expect(isExtensionEnabled('all', 'crm')).toBe(true);
    expect(isExtensionEnabled(['crm'], 'crm')).toBe(true);
    expect(isExtensionEnabled(['crm'], 'drive')).toBe(false);
    expect(isExtensionEnabled([], 'crm')).toBe(false);
  });
});
