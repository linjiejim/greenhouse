import { registerApplicationPage } from '../lib/extension-registries';
import { useExtensionsStore } from '../stores/extensions-store';
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

const labels = { files: 'Files', skillhub: 'SkillHub', automations: 'Automation' };

describe('Primary navigation', () => {
  it('orders the workspace by goal and puts the assistant last', () => {
    registerApplicationPage('fixture', 'fixture', 'fixture');
    useExtensionsStore.setState({ extensions: [{ id: 'fixture', name: 'Fixture', description: null }] });
    const { primary, overflow } = buildPrimaryNavigation({
      applications: [application('analytics'), application('fixture'), application('knowledge')],
      labels,
    });

    expect(primary.map((item) => item.key)).toEqual(['knowledge', 'files', 'fixture', 'skillhub', 'automations']);
    expect(primary.map((item) => item.href)).toContain('#/files');
    // Agent/MCP-only catalog entries have no browser route, so they never
    // surface as a tab — not even in More.
    expect(overflow).toEqual([]);
  });

  it('omits unauthorized apps but keeps the fixed destinations', () => {
    const { primary } = buildPrimaryNavigation({ applications: [application('knowledge')], labels });
    expect(primary.map((item) => item.key)).toEqual(['knowledge', 'files', 'skillhub', 'automations']);
  });

  it('has no Home item (Home is the conversation) and keeps the Activity log out of the primary list', () => {
    const navigation = buildPrimaryNavigation({ applications: [], labels });
    expect(navigation.primary.map((item) => item.key)).not.toContain('home');
    expect(navigation.primary.map((item) => item.href)).not.toContain('#/activity');
    // the assistant has no item: New Chat opens it
    expect(navigation.primary.map((item) => item.key)).not.toContain('chat');
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

  it('lights nothing in a conversation or on Home (New Chat is their way in)', () => {
    expect(activeNavigationKey('chat')).toBeNull();
    expect(activeNavigationKey('home')).toBeNull();
  });
});
