export const messages = {
  en: {
    feishu: {
      title: 'Feishu',
      hint: 'Connect your Feishu account to receive notifications as direct messages and sign in by scan.',
      connected: 'Connected',
      boundAs: 'Connected as {name} · {at}',
      bind: 'Connect',
      unbind: 'Disconnect',
      bound: 'Feishu account connected',
      unbound: 'Feishu account disconnected',
      bindFailed: 'Could not connect the Feishu account',
      unbindFailed: 'Could not disconnect the Feishu account',
    },
    login: {
      feishu: 'Sign in with Feishu',
      feishuSigningIn: 'Signing in with Feishu...',
      feishuNotBound:
        'This Feishu account is not linked yet. Sign in with email first, then connect Feishu in Settings.',
      feishuFailed: 'Feishu sign-in failed. Please try again.',
      or: 'or',
    },
    automations: {
      notifyFeishu: 'Feishu message',
      notifyFeishuHint: 'Send the run summary to you as a Feishu card message.',
      notifyFeishuUnbound: 'Bind your Feishu account in Settings to enable this.',
      notifyWebhook: 'Group-bot webhook',
      notifyWebhookHint: 'Optional. Posts each run summary to a WeCom or Feishu group chat.',
    },
  },
  zh: {
    feishu: {
      title: '飞书',
      hint: '绑定飞书后，通知会以卡片消息直接推送给你，还可以用飞书扫码登录。',
      connected: '已绑定',
      boundAs: '已绑定 {name} · {at}',
      bind: '绑定',
      unbind: '解绑',
      bound: '飞书已绑定',
      unbound: '飞书已解绑',
      bindFailed: '飞书绑定失败',
      unbindFailed: '飞书解绑失败',
    },
    login: {
      feishu: '用飞书登录',
      feishuSigningIn: '飞书登录中...',
      feishuNotBound: '该飞书账号尚未绑定。请先用邮箱登录，再到设置里绑定飞书。',
      feishuFailed: '飞书登录失败，请重试。',
      or: '或',
    },
    automations: {
      notifyFeishu: '飞书消息',
      notifyFeishuHint: '把本次运行摘要以飞书卡片消息发给你本人。',
      notifyFeishuUnbound: '先在设置里绑定飞书才能开启。',
      notifyWebhook: '群机器人 Webhook',
      notifyWebhookHint: '可选。每次运行结束后，将摘要推送到企微或飞书群聊。',
    },
  },
};
