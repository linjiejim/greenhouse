import { describe, expect, it } from 'vitest';
import { parseManifest } from '../plugins/manifest';
import {
  CORE_SECTIONS,
  activeSection,
  isCoreSection,
  pluginSections,
} from './sections';

const station = (pages: unknown[], id = 'feedback') =>
  parseManifest({
    manifest_version: 2,
    core: { version: '4.0.0', client_api: 4 },
    plugins: [{ id, name: 'Feedback', nav: [], pages }],
  });

describe('Admin sections', () => {
  it('lists plugin Admin pages from the manifest only, with compiled screens or a settings form', () => {
    const state = station([
      { id: 'feedback', kind: 'native', screen: 'feedback', title: 'Feedback' },
      {
        id: 'issues',
        kind: 'native',
        screen: 'feedback-issues',
        title: { en: 'Issues', zh: '问题与需求' },
        parent: 'administration',
      },
      { id: 'future', kind: 'native', screen: 'unknown-screen', title: 'Future', parent: 'administration' },
      { id: 'settings', kind: 'settings-form', title: 'Settings', settings: ['a'], parent: 'administration' },
      { id: 'mine', kind: 'settings-form', title: 'Mine', settings: ['b'], parent: 'settings' },
    ]);
    const sections = pluginSections(state, { 'feedback-issues': 'form' });
    expect(sections.map((s) => [s.page, s.icon, s.href])).toEqual([
      ['issues', 'form', '/admin/p/feedback/issues'],
      ['settings', 'gear', '/admin/p/feedback/settings'],
    ]);
  });

  it('has no plugin sections before the manifest arrives', () => {
    expect(pluginSections({ kind: 'pending' }, { x: 'form' })).toEqual([]);
  });

  it('reads the active section from the path', () => {
    expect(activeSection('/admin')).toEqual({ core: 'users' });
    expect(activeSection('/admin/services?tab=x')).toEqual({ core: 'services' });
    expect(activeSection('/admin/p/feedback/issues')).toEqual({ plugin: 'feedback', page: 'issues' });
    expect(activeSection('/admin/issues')).toBeNull();
    expect(activeSection('/knowledge')).toBeNull();
  });

  it('names core sections', () => {
    expect(CORE_SECTIONS.map((s) => s.id)).toContain('runtime-config');
    expect(isCoreSection('mcp-keys')).toBe(true);
    expect(isCoreSection('issues')).toBe(false);
  });
});
