import manifest from '../manifest.js';
import { defineWebExtension } from '@greenhouse/web/extension-kit';
import en from './messages/en.js';
import zh from './messages/zh.js';
import { Monitor } from '@greenhouse/web/extension-kit';
import { ComputerPanel } from './pages/settings/computer.js';
import { ComputerAdminSection } from './pages/administration/computer-admin.js';
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  modules: [
    {
      key: 'computer',
      parent: 'settings',
      labelKey: 'ext.computer.nav_computer',
      descriptionKey: 'ext.computer.nav_computerDesc',
      icon: Monitor,
      component: ComputerPanel,
    },
  ],
  mcpGroups: [{ id: 'computer', labelKey: 'ext.computer.mcp.label', descriptionKey: 'ext.computer.mcp.description' }],
  slots: [{ slot: 'services-pricing', component: ComputerAdminSection }],
});
