import manifest from '../manifest.js';
import { defineExtension, extensionPath, requireInternal } from '@greenhouse/api/extension-kit';
import { createServices } from './services.js';
import { memoryRoutes } from './routes.js';
import { memoryTool } from './tools/memory.js';
import { resolveMemoryContext, runMemoryConsolidation } from './llm/memory.js';
export default defineExtension({
  ...manifest,
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  services: createServices,
  seeds: [{ dir: extensionPath(import.meta.url, '../seeds'), tables: ['memories'] }],
  automationTools: [{ id: 'memory', labelKey: 'ext.memory.automationTool', tier: 'assist', order: 0 }],
  resetTables: ['memories'],
  featureFlags: [
    {
      key: 'memory',
      label: 'AI Memory',
      description: 'Agent learns and remembers user preferences across sessions',
      // On for everyone unless explicitly disabled — memory is only useful if it
      // accumulates, and an opt-in allowlist kept it empty for its entire v1 life.
      defaultEnabled: true,
    },
  ],
  featurePoints: [
    {
      key: 'memory',
      title: 'AI Memory',
      description: 'The agent learns and remembers this user’s preferences across sessions.',
      icon: 'Brain',
      kind: 'flag',
      group: 'basic',
      flag: 'memory',
      toolIds: ['memory'],
    },
  ],
  routes: [{ path: '/api/auth/me/memories', app: memoryRoutes, guards: [requireInternal()] }],
  tools: [memoryTool],
  promptContext: [{ toolIds: ['memory'], build: (id, role) => resolveMemoryContext(id, role as 'team' | 'super') }],
  jobs: [
    {
      id: 'memory-consolidation',
      cron: '0 5 * * 0',
      timezone: 'Asia/Shanghai',
      run: async () => {
        await runMemoryConsolidation();
      },
    },
  ],
});
