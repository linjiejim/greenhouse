import { registerApplicationPage } from '../lib/extension-registries';
import { useExtensionsStore } from '../stores/extensions-store';
import { describe, expect, it } from 'vitest';
import { orderPlatformApplications, platformApplicationHref, type PlatformApplication } from './catalog.js';

function application(id: string, path = `/${id}`): PlatformApplication {
  return {
    id,
    version: '1.0.0',
    title: id,
    modules: {},
    actions: {},
    navigation: [{ id, title: id, module: 'main', path }],
    capabilities: [],
  };
}

describe('Platform web catalog', () => {
  it('orders applications by title', () => {
    expect(orderPlatformApplications([application('tables'), application('knowledge')]).map((a) => a.id)).toEqual([
      'knowledge',
      'tables',
    ]);
  });

  it('only links applications with an explicitly registered host UI', () => {
    expect(platformApplicationHref(application('fixture'))).toBeNull();
    registerApplicationPage('fixture', 'fixture', 'fixture-records');
    useExtensionsStore.setState({ extensions: [{ id: 'fixture', name: 'Fixture', description: null }] });
    expect(platformApplicationHref(application('fixture'))).toBe('#/fixture-records');
    useExtensionsStore.setState({ extensions: [] });
    expect(platformApplicationHref(application('fixture'))).toBeNull();
    expect(platformApplicationHref(application('tables'))).toBe('#/tables');
    expect(platformApplicationHref(application('pulse'))).toBeNull();
    expect(platformApplicationHref(application('analytics', 'https://example.test'))).toBeNull();
  });
});
