import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../extensions/compiled.generated', () => ({
  COMPILED_PLUGINS: [
    {
      id: 'slot-fixture',
      sdk: 1,
      core: '>=3 <5',
      slots: [{ slot: 'services-pricing', component: () => null }],
      tabs: [{ host: 'skillhub', key: 'fixture', labelKey: 'ext.slot-fixture.tab', component: () => null }],
    },
  ],
}));
import { extensionSlots, extensionTabs } from '../extensions';
import { useExtensionsStore } from '../stores/extensions-store';
afterEach(() => useExtensionsStore.getState().reset());
it('shows only the active fixture plugin tabs and settings slots', () => {
  expect(extensionTabs('skillhub')).toEqual([]);
  expect(extensionSlots('services-pricing')).toEqual([]);
  useExtensionsStore.setState({ extensions: [{ id: 'slot-fixture', name: 'Fixture', description: null }] });
  expect(extensionTabs('skillhub').map((tab) => tab.key)).toEqual(['fixture']);
  expect(extensionSlots('services-pricing')).toHaveLength(1);
});
