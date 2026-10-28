import manifest from '../manifest.js';
import { defineExtension, extensionPath, getDb, requireInternal, requireSuper } from '@greenhouse/api/extension-kit';
import { createServices } from './services.js';
import { adminComputerRoutes, computerRoutes } from './routes/computer.js';
import {
  computerExecTool,
  computerFilesTool,
  computerTransferTool,
  computerStopTool,
  computerToolUnavailableMessage,
} from './tools/computer.js';
import { E2B_DOMAIN_PATTERN, E2B_TEMPLATE_PATTERN } from './config.js';
import { isComputerEnabled, sweepComputers } from './service.js';
export default defineExtension({
  ...manifest,
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  services: createServices,
  hubContext: [
    {
      group: 'computer',
      description: 'Your cloud computer (runs commands; billed per minute)',
      toolIds: ['computer_exec', 'computer_files'],
    },
  ],
  resetTables: ['member_computers'],
  mcpGroups: ['computer'],
  tools: [computerExecTool, computerFilesTool, computerTransferTool, computerStopTool],
  routes: [
    { path: '/api/computer', app: computerRoutes, guards: [requireInternal()] },
    { path: '/api/admin/computers', app: adminComputerRoutes, guards: [requireSuper()] },
  ],
  activity: [{ adminActions: { settings: ['stopMemberComputer'] } }],
  toolAvailability: [computerToolUnavailableMessage],
  billableServices: [
    {
      service: 'computer',
      name: 'Cloud computer',
      unit: 'minute',
      enabled: true,
      providers: { e2b: { provider: 'e2b', apiKeyEnv: ['E2B_API_KEY'], price: 0.0018 } },
      isEnabled: isComputerEnabled,
    },
  ],
  jobs: [
    {
      id: 'computer-sweep',
      cron: '* * * * *',
      run: async () => {
        await sweepComputers(getDb());
      },
    },
  ],
  settingValidators: [
    (key, value) => {
      if (key === 'computer.max_running' && !(/^\d+$/.test(value) && Number(value) >= 1 && Number(value) <= 1000))
        return 'computer.max_running must be a whole number from 1 to 1000';
      if (key === 'computer.domain' && !E2B_DOMAIN_PATTERN.test(value.toLowerCase()))
        return 'computer.domain must be a domain name such as e2b.app';
      if (key === 'computer.template' && !E2B_TEMPLATE_PATTERN.test(value))
        return 'computer.template must be a template name or id';
      return null;
    },
  ],
  workspaceSettings: [
    // ── Cloud computer (members' hosted sandboxes, v1.6) — off by default ──
    {
      key: 'computer.enabled',
      group: 'computer',
      label: 'Cloud computer',
      description:
        "Lets members' agents start their own cloud computer (E2B), billed per minute; off stops running ones. Also switched on Services & pricing. Off by default.",
      type: 'boolean',
      env: 'COMPUTER_ENABLED',
      defaultValue: false,
    },
    {
      key: 'computer.api_key',
      group: 'computer',
      label: 'E2B API key',
      description: 'Key of the E2B account that hosts the cloud computers',
      type: 'string',
      secret: true,
      env: 'E2B_API_KEY',
    },
    {
      key: 'computer.template',
      group: 'computer',
      label: 'E2B template',
      description: 'Template each computer starts from (default `base`, E2B’s stock Linux image)',
      type: 'string',
      env: 'E2B_TEMPLATE',
      placeholder: 'base',
    },
    {
      key: 'computer.domain',
      group: 'computer',
      label: 'E2B domain',
      description: 'The provider’s domain; another E2B-protocol host (e.g. PPIO) has its own',
      type: 'string',
      env: 'E2B_DOMAIN',
      placeholder: 'e2b.app',
    },
    {
      key: 'computer.max_running',
      group: 'computer',
      label: 'Computers at once',
      description: 'How many cloud computers may run at the same time across the workspace (default 5)',
      type: 'string',
      env: 'COMPUTER_MAX_RUNNING',
      placeholder: '5',
    },
  ],
});
