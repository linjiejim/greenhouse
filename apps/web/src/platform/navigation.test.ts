import { describe, expect, it } from 'vitest';
import type { PlatformApplication } from './catalog.js';
import { activeNavigationKey, buildPrimaryNavigation, PRIMARY_NAV_ORDER } from './navigation.js';

function application(id: string): PlatformApplication {
  return {
    id,
    version: '1.0.0',
    title: id[0].toUpperCase() + id.slice(1),
    modules: {},
    actions: {},
    navigation: [{ id, title: id, module: 'main', path: `/${id}` }],
    capabilities: [],
  };
}

const labels = { home: 'Home', files: 'Files', skillhub: 'SkillHub', automations: 'Automation', chat: 'Chat' };

describe('Primary navigation', () => {
  it('orders the workspace by goal and puts the assistant last', () => {
    const { primary, overflow } = buildPrimaryNavigation({
      applications: [
        application('analytics'),
        application('tables'),
        application('knowledge'),
        application('projects'),
      ],
      labels,
    });

    expect(primary.map((item) => item.key)).toEqual([
      'home',
      'knowledge',
      'files',
      'tables',
      'projects',
      'skillhub',
      'automations',
      'chat',
    ]);
    expect(primary.map((item) => item.href)).toContain('#/files');
    // Agent/MCP-only catalog entries have no browser route, so they never
    // surface as a tab — not even in More.
    expect(overflow).toEqual([]);
  });

  it('omits unauthorized apps but keeps the fixed destinations', () => {
    const { primary } = buildPrimaryNavigation({ applications: [application('knowledge')], labels });
    expect(primary.map((item) => item.key)).toEqual(['home', 'knowledge', 'files', 'skillhub', 'automations', 'chat']);
  });

  it('leads with Home and keeps the Activity log out of the primary list (it has a fixed entry)', () => {
    const navigation = buildPrimaryNavigation({ applications: [], labels });
    expect(navigation.primary[0]).toMatchObject({ key: 'home', href: '#/home' });
    expect(navigation.primary.map((item) => item.href)).not.toContain('#/activity');
    expect(navigation.primary.at(-1)?.key).toBe('chat');
  });
});

describe('activeNavigationKey', () => {
  it('lights the item each primary page belongs to', () => {
    for (const key of PRIMARY_NAV_ORDER) expect(activeNavigationKey(key)).toBe(key);
  });

  it('lights nothing in the primary list on pages the account menu or admin owns', () => {
    for (const route of ['activity', 'settings', 'administration', 'design', 'extension']) {
      expect(activeNavigationKey(route)).toBeNull();
    }
  });

  it('lights Chat only for the conversation itself', () => {
    expect(activeNavigationKey('chat', 'conversation')).toBe('chat');
    expect(activeNavigationKey('chat', 'history')).toBeNull();
  });
});
