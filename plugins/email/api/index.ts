import manifest from '../manifest.js';
import { defineExtension, extensionPath, requireInternal, requireFeature } from '@greenhouse/api/extension-kit';
import { createServices } from './services.js';
import { createEmailRoutes } from './routes.js';
import { emailQueryTool } from './tools/email-query.js';
import { emailMutationTool } from './tools/email-mutation.js';
import { transport } from './transport.js';
export default defineExtension({
  ...manifest,
  configurationEnv: [
    'SHARED_MAILBOX_ADDRESS',
    'SHARED_MAILBOX_PASSWORD',
    'MAIL_EGRESS_PROXY',
    'SHARED_MAILBOX_IMAP_HOST',
    'SHARED_MAILBOX_IMAP_PORT',
    'SHARED_MAILBOX_SMTP_HOST',
    'SHARED_MAILBOX_SMTP_PORT',
    'SHARED_MAILBOX_USERNAME',
    'SHARED_MAILBOX_DISPLAY_NAME',
    'SHARED_MAILBOX_USE_TLS',
    'SHARED_MAILBOX_USE_PROXY',
    'SHARED_MAILBOX_ALLOWED_DOMAIN',
  ],
  migrations: { dir: extensionPath(import.meta.url, '../migrations') },
  services: createServices,
  resetTables: ['email_accounts'],
  tools: [emailQueryTool, emailMutationTool],
  featureFlags: [{ key: 'email', label: 'Email', description: 'Personal and shared mailboxes', defaultEnabled: true }],
  featurePoints: [
    {
      key: 'email',
      title: 'Email',
      description: 'Read mailboxes and send confirmed drafts',
      icon: 'Mail',
      kind: 'flag',
      flag: 'email',
      group: 'basic',
      toolIds: ['email_query', 'email_mutation'],
    },
  ],
  routes: [{ path: '/api/email', app: createEmailRoutes(), guards: [requireInternal(), requireFeature('email')] }],
  notificationTransports: [transport],
  activity: [{ toolModules: { email_mutation: 'email' }, toolWrites: { email_mutation: { entity: 'email' } } }],
});
