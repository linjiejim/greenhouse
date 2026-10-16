import { describe, expect, it } from 'vitest';
import { providersFromEnv } from '../../../providers/env.js';
// The smtp adapter registers itself; env settings are checked against it.
import '../../mail/smtp.js';

describe('channels from env', () => {
  it('reads SMTP_*, FEISHU_*, WECOM_* and PUSH_PROVIDER into channel instances', () => {
    const { instances } = providersFromEnv({
      SMTP_HOST: 'smtp.acme.com',
      SMTP_PORT: '465',
      SMTP_SECURITY: 'tls',
      SMTP_USER: 'gh@acme.com',
      SMTP_PASSWORD: 'smtp-secret',
      SMTP_FROM: 'gh@acme.com',
      SMTP_FROM_NAME: 'Acme',
      FEISHU_APP_ID: 'cli_1',
      FEISHU_APP_SECRET: 'feishu-secret',
      WECOM_CORP_ID: 'ww1',
      WECOM_AGENT_ID: '1000002',
      WECOM_APP_SECRET: 'wecom-secret',
      PUSH_PROVIDER: 'expo',
      EXPO_ACCESS_TOKEN: 'expo-token',
    });
    expect(instances).toEqual([
      {
        id: 'env-mail-smtp',
        capability: 'mail',
        kind: 'smtp',
        preset: null,
        name: 'SMTP',
        config: {
          host: 'smtp.acme.com',
          port: '465',
          security: 'tls',
          username: 'gh@acme.com',
          fromAddress: 'gh@acme.com',
          fromName: 'Acme',
        },
        secrets: { password: 'smtp-secret' },
      },
      {
        id: 'env-im-feishu',
        capability: 'im',
        kind: 'feishu',
        preset: null,
        name: '飞书',
        config: { appId: 'cli_1' },
        secrets: { appSecret: 'feishu-secret' },
      },
      {
        id: 'env-im-wecom',
        capability: 'im',
        kind: 'wecom',
        preset: null,
        name: '企业微信',
        config: { corpId: 'ww1', agentId: '1000002' },
        secrets: { secret: 'wecom-secret' },
      },
      {
        id: 'env-push',
        capability: 'push',
        kind: 'expo',
        preset: null,
        name: 'Expo',
        config: {},
        secrets: { accessToken: 'expo-token' },
      },
    ]);
  });

  it('leaves out a channel whose env settings are incomplete', () => {
    const { instances } = providersFromEnv({
      SMTP_HOST: 'smtp.acme.com',
      WECOM_CORP_ID: 'ww1',
      PUSH_PROVIDER: 'apns',
    });
    expect(instances).toEqual([]);
  });
});
