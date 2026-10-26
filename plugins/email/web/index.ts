import manifest from '../manifest.js';
import { defineWebExtension, Mail } from '@greenhouse/web/extension-kit';
import { messages } from './messages';
import { lazy } from 'react';
const EmailAccountsPanel = lazy(() => import('./accounts').then((m) => ({ default: m.EmailAccountsPanel })));

import { NotificationPreference } from './preference';
export default defineWebExtension({
  ...manifest,
  messages,
  modules: [
    {
      key: 'email-accounts',
      parent: 'settings',
      labelKey: 'ext.email.navigation.emailAccounts',
      descriptionKey: 'ext.email.navigation.emailAccountsDesc',
      icon: Mail,
      component: EmailAccountsPanel,
      requireFeature: 'email',
    },
  ],
  toolIcons: { email_query: Mail, email_mutation: Mail },
  notificationTransports: [{ id: 'email', preference: 'notify_email', component: NotificationPreference }],
});
