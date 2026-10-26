import { it, expect, afterEach } from 'vitest';
import '../../../apps/web/src/extensions/index';
import { resolveSettingsRedirect, resolveAdministrationRedirect } from '../../../apps/web/src/pages/settings/redirects';
import { useExtensionsStore } from '../../../apps/web/src/stores/extensions-store';
afterEach(() => useExtensionsStore.getState().reset());
it('sends the retired request and friction queues to their Issues & requests tabs', () => {
  useExtensionsStore.setState({ extensions: [{ id: 'feedback', name: 'Feedback', description: null }] });
  expect(resolveSettingsRedirect('feature-requests')).toBe('#/administration/issues/requests');
  expect(resolveSettingsRedirect('frictions/123')).toBe('#/administration/issues/frictions/123');
  expect(resolveAdministrationRedirect('frictions')).toBe('#/administration/issues/frictions');
  expect(resolveAdministrationRedirect('feature-requests')).toBe('#/administration/issues/requests');
  expect(resolveAdministrationRedirect('issues/frictions')).toBeNull();
});

it('has no feedback redirects when disabled', () => {
  expect(resolveSettingsRedirect('feature-requests')).toBeNull();
  expect(resolveAdministrationRedirect('frictions')).toBeNull();
});
