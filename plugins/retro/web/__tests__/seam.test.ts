/** @vitest-environment happy-dom */
import { afterEach, expect, it } from 'vitest';
import {
  extensionModuleComponent,
  extensionSlots,
  extensionSurfaces,
} from '../../../../apps/web/src/extensions/index.js';
import { useExtensionsStore } from '../../../../apps/web/src/stores/extensions-store.js';
afterEach(() => useExtensionsStore.setState({ extensions: [], loaded: false }));
it('hides its admin module and feedback action when disabled', () => {
  useExtensionsStore.setState({ extensions: [], loaded: true });
  expect(extensionModuleComponent('administration', 'retro')).toBeUndefined();
  expect(extensionSlots('feedback.actions')).toEqual([]);
  expect(extensionSurfaces()).toEqual([]);
});
it('offers its admin module independently of Feedback', () => {
  useExtensionsStore.setState({ extensions: [{ id: 'retro', name: 'Retro', description: null }], loaded: true });
  expect(extensionModuleComponent('administration', 'retro')).toMatchObject({ requireRole: ['super'] });
  expect(extensionSlots('feedback.actions')).toHaveLength(1);
  expect(extensionSurfaces().some((surface) => surface.hash === '#/administration/retro')).toBe(true);
});
