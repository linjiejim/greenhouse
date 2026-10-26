export const messages = {
  en: {
    wecom: {
      title: 'WeCom',
      hint: 'Connect your WeCom account to receive notifications as direct messages.',
      connected: 'Connected',
      boundAs: 'Connected as {name} · {at}',
      bind: 'Connect',
      unbind: 'Disconnect',
      bound: 'WeCom account connected',
      unbound: 'WeCom account disconnected',
      bindFailed: 'Could not connect the WeCom account',
      unbindFailed: 'Could not disconnect the WeCom account',
    },
    automations: {
      notifyWeCom: 'WeCom message',
      notifyWeComHint: 'Send the run summary to you as a WeCom app message.',
      notifyWeComUnbound: 'Bind your WeCom account in Settings to enable this.',
      notifyWebhook: 'Group-bot webhook',
      notifyWebhookHint: 'Optional. Posts each run summary to a WeCom or Feishu group chat.',
    },
  },
  zh: {
    wecom: {
      title: '企业微信',
      hint: '绑定企业微信后，通知会以应用消息直接推送给你。',
      connected: '已绑定',
      boundAs: '已绑定 {name} · {at}',
      bind: '绑定',
      unbind: '解绑',
      bound: '企业微信已绑定',
      unbound: '企业微信已解绑',
      bindFailed: '企业微信绑定失败',
      unbindFailed: '企业微信解绑失败',
    },
    automations: {
      notifyWeCom: '企业微信消息',
      notifyWeComHint: '把本次运行摘要以企业微信应用消息发给你本人。',
      notifyWeComUnbound: '先在设置里绑定企业微信才能开启。',
      notifyWebhook: '群机器人 Webhook',
      notifyWebhookHint: '可选。每次运行结束后，将摘要推送到企微或飞书群聊。',
    },
  },
};
