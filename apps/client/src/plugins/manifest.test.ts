import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { builtinVisible, fallbackUrl, fetchManifest, hasPlugin, parseManifest, PENDING_MANIFEST, pluginNavigation } from './manifest';
const v2 = (plugins: unknown[] = []) => ({
  manifest_version: 2,
  core: { version: '4.0.0', client_api: 4 },
  plugins,
});
describe('station manifest', () => {
  it('vendors the complete wire contract verbatim', () => {
    expect(
      readFileSync(new URL('../shared/plugins.ts', import.meta.url), 'utf8')
        .split('\n')
        .slice(1)
        .join('\n'),
    ).toBe(readFileSync(new URL('../../../../packages/types/src/plugins.ts', import.meta.url), 'utf8'));
  });
  it('accepts only v2 and shows nothing while pending', async () => {
    // a 3.x station's v1 manifest
    expect(() => parseManifest({ extensions: [], entityKinds: [] })).toThrow('Unsupported station manifest version');
    await expect(fetchManifest(async () => ({ status: 404, ok: false, json: async () => null }))).rejects.toThrow(
      '404',
    );
    await expect(fetchManifest(async () => ({ status: 401, ok: false, json: async () => null }))).rejects.toThrow(
      '401',
    );
    expect(() => parseManifest(v2(null as never))).toThrow();
    expect(hasPlugin(PENDING_MANIFEST, 'knowledge')).toBe(false);
    expect(builtinVisible(PENDING_MANIFEST, 'knowledge')).toBe(false);
    expect(pluginNavigation(PENDING_MANIFEST, 'more')).toEqual([]);
  });
  it('does not show an inactive built-in, preserves unknown page kinds, sorts more', () => {
    const state = parseManifest(
      v2([
        { id: 'knowledge', nav: [], pages: [] },
        {
          id: 'crm',
          nav: [{ id: 'crm', page: 'future', placement: 'more', order: 101 }],
          pages: [{ id: 'future', kind: 'future-kind', fallback_url: '/classic/#/crm' }],
        },
      ]),
    );
    expect(hasPlugin(state, 'knowledge')).toBe(true);
    expect(hasPlugin(state, 'projects')).toBe(false);
    expect(pluginNavigation(state, 'primary')).toEqual([]);
    expect(pluginNavigation(state, 'more')[0]?.page.kind).toBe('future-kind');
  });
  it('trusts v2 permissions', () => {
    const state = parseManifest(
      v2([
        {
          id: 'tables',
          nav: [{ id: 'tables', page: 'index', placement: 'primary' }],
          pages: [{ id: 'index', kind: 'native', screen: 'tables' }],
        },
      ]),
    );
    expect(builtinVisible(parseManifest(v2([{ id: 'tables', nav: [], pages: [] }])), 'tables')).toBe(false);
    expect(builtinVisible(state, 'tables')).toBe(true);
    expect(builtinVisible(parseManifest(v2()), 'tables')).toBe(false);
  });
  it('refuses active content URLs and sends classic hash fallbacks to classic', () => {
    expect(fallbackUrl({ fallback_url: 'javascript:alert(1)' }, 'https://station.test')).toBeNull();
    // the classic client's hash routes have no target after 4.0
    expect(fallbackUrl({ fallback_url: '#/crm' }, 'https://station.test')).toBeNull();
    expect(fallbackUrl({ fallback_url: '/classic/#/crm' }, 'https://station.test')).toBeNull();
    expect(fallbackUrl({ fallback_url: 'https://crm.example.com/x' }, 'https://station.test')).toBe('https://crm.example.com/x');
  });
});
