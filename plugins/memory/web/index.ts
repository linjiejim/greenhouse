import manifest from '../manifest.js';
import { defineWebExtension } from '@greenhouse/web/extension-kit';
import en from './messages/en.js';
import zh from './messages/zh.js';
import { Brain } from '@greenhouse/web/extension-kit';
import { MemoryPanel } from './pages/settings/memory.js';
export default defineWebExtension({
  ...manifest,
  messages: { en, zh },
  modules: [
    {
      key: 'memory',
      parent: 'settings',
      labelKey: 'ext.memory.nav_memory',
      descriptionKey: 'ext.memory.nav_memoryDesc',
      icon: Brain,
      component: MemoryPanel,
      requireFeature: 'memory',
    },
  ],
  toolIcons: { memory: Brain },
});
