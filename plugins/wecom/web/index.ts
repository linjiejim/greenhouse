import manifest from '../manifest.js';
import { defineWebExtension } from '@greenhouse/web/extension-kit';
import { messages } from './messages';
import { WeComBindingCard } from './binding';

import { NotificationPreference } from './preference';
export default defineWebExtension({
  ...manifest,
  messages,
  identityProviders: [{ id: 'wecom', binding: WeComBindingCard }],
  notificationTransports: [
    {
      id: 'wecom',
      preference: 'notify_wecom',
      webhook: { labelKey: 'ext.wecom.automations.notifyWebhook', hintKey: 'ext.wecom.automations.notifyWebhookHint' },
      component: NotificationPreference,
    },
  ],
});
