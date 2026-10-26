import manifest from '../manifest.js';
import { defineExtension, extensionPath } from '@greenhouse/api/extension-kit';
import { identityProvider, feishuLoginRoutes } from './oauth.js';
import { transport } from './transport.js';
import { createServices } from './services.js';
import { initFeishuBot, stopFeishuBot } from './bot/client.js';
export default defineExtension({
  ...manifest,
  configurationEnv: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_BOT_ENABLED'],
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  services: createServices,
  resetTables: ['feishu_conversations', 'feishu_receipts'],
  retention: [{ table: 'feishu_receipts', column: 'received_at', days: 7 }],
  identityProviders: [identityProvider],
  notificationTransports: [transport],
  routes: [{ path: '/api/feishu', app: feishuLoginRoutes }],
  publicPaths: {
    exact: [
      '/api/feishu/login-available',
      '/api/feishu/oauth/start-login',
      '/api/feishu/oauth/callback',
      '/api/feishu/oauth/exchange',
    ],
  },
  channels: [
    {
      id: 'feishu',
      start: async ({ toolRegistry }) => {
        await initFeishuBot(toolRegistry);
        return stopFeishuBot;
      },
    },
  ],
});
