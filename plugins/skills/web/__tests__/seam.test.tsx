import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it } from 'vitest';
import { useExtensionsStore } from '../../../../apps/web/src/stores/extensions-store.js';
import { SkillHubPage } from '../../../../apps/web/src/pages/skillhub/index.js';
import { extensionTabs } from '../../../../apps/web/src/extensions/index.js';
afterEach(() => useExtensionsStore.setState({ extensions: [], loaded: false }));
it('keeps My prompts usable while the skill catalogue is disabled', () => {
  useExtensionsStore.setState({ extensions: [], loaded: true });
  expect(extensionTabs('skillhub').some((tab) => tab.key === 'skills')).toBe(false);
  const html = renderToStaticMarkup(<SkillHubPage subPath="" />);
  expect(html).toContain('My prompts');
  expect(html).not.toContain('SkillHub');
  expect(html).not.toContain('Upload');
});
it('registers the enabled catalogue as the default library tab with its sidebar', () => {
  useExtensionsStore.setState({ extensions: [{ id: 'skills', name: 'SkillHub', description: null }], loaded: true });
  expect(extensionTabs('skillhub').find((tab) => tab.default)).toMatchObject({
    key: 'skills',
    titleKey: 'ext.skills.skillHub.title',
    page: true,
  });
  expect(extensionTabs('skillhub').find((tab) => tab.default)?.sidebarPanel).toBeTypeOf('function');
});
