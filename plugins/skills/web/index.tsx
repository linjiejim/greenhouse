import React from 'react';
import manifest from '../manifest.js';
import { defineWebExtension, Package, Upload } from '@greenhouse/web/extension-kit';
import en from './messages/en.js';
import zh from './messages/zh.js';
import { SkillHubPage } from './page.js';
import { SkillHubNavPanel } from './sidebar.js';
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  tabs: [
    {
      host: 'skillhub',
      key: 'skills',
      default: true,
      page: true,
      labelKey: 'ext.skills.skillHub.tabs.skills',
      titleKey: 'ext.skills.skillHub.title',
      descriptionKey: 'ext.skills.navigation.skillHubDesc',
      component: SkillHubPage,
      sidebarPanel: ({ subPath }) => <SkillHubNavPanel activeName={subPath} />,
    },
  ],
  toolIcons: { skill_query: Package, skill_mutation: Upload },
  mcpGroups: [
    {
      id: 'skills',
      labelKey: 'ext.skills.mcpGroups.skills.label',
      descriptionKey: 'ext.skills.mcpGroups.skills.description',
    },
  ],
});
