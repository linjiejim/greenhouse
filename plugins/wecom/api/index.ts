import manifest from '../manifest.js';
import { defineExtension } from '@greenhouse/api/extension-kit';
import { identityProvider } from './oauth.js';
import { transport } from './transport.js';
export default defineExtension({
  ...manifest,
  configurationEnv: [
    'WECOM_CORP_ID',
    'WECOM_AGENT_ID',
    'WECOM_APP_SECRET',
    'SKILLS_WECOM_WEBHOOK_URL',
    'SYNC_WECOM_WEBHOOK_URL',
  ],
  identityProviders: [identityProvider],
  notificationTransports: [transport],
  publicPaths: { exact: ['/api/wecom/oauth/callback'] },
});
