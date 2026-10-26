import manifest from '../manifest.js';
import { defineWebExtension } from '@greenhouse/web/extension-kit';
import { messages } from './messages';
import { FeishuBindingCard } from './binding';
import { FeishuLogin } from './login';
import { NotificationPreference } from './preference';
export default defineWebExtension({
  ...manifest,
  messages,
  identityProviders: [{ id: 'feishu', binding: FeishuBindingCard, login: FeishuLogin }],
  notificationTransports: [
    {
      id: 'feishu',
      preference: 'notify_feishu',
      webhook: {
        labelKey: 'ext.feishu.automations.notifyWebhook',
        hintKey: 'ext.feishu.automations.notifyWebhookHint',
      },
      component: NotificationPreference,
    },
  ],
});
