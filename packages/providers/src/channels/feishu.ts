/**
 * Feishu (and Lark) as a channel: the workspace's own app sends a person a direct message by
 * their open_id, with a tenant access token (cached, renewed once when it dies early). Messages
 * are plain text, so nothing in them is read as markup.
 */

import { z } from 'zod';
import { UndeliverableError, type ImClient, type ProviderAdapter } from '../types.js';
import { appKey, appToken, exchange, failure, forgetToken } from './shared.js';

const configSchema = z.object({
  baseUrl: z.string().url().default('https://open.feishu.cn'),
  appId: z.string().trim().min(1).max(64),
});
export type FeishuConfig = z.infer<typeof configSchema>;

const TIMEOUT_MS = 15_000;
/** The cached tenant token died early: get a new one, once. */
const TOKEN_DEAD = new Set([99991661, 99991663, 99991668]);
/** The person cannot get messages from this app (not in its scope, another app's open_id, unknown). */
const RECIPIENT_REFUSED = new Set([230013, 99992361, 99992351]);

export const feishuAdapter: ProviderAdapter<'im', FeishuConfig> = {
  capability: 'im',
  kind: 'feishu',
  label: '飞书',
  configSchema: configSchema as z.ZodType<FeishuConfig>,
  secretKeys: ['appSecret'],
  requiredSecrets: ['appSecret'],
  presets: [
    { id: 'feishu', label: '飞书', config: { baseUrl: 'https://open.feishu.cn' } },
    { id: 'lark', label: 'Lark', config: { baseUrl: 'https://open.larksuite.com' } },
  ],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const base = `${config.baseUrl.replace(/\/+$/, '')}/open-apis`;
    const key = appKey('feishu', base, config.appId, secrets.appSecret ?? '');
    const call = (label: string, extra: string[] = []) => ({
      label,
      secrets: [secrets.appSecret, ...extra],
      timeoutMs: TIMEOUT_MS,
    });

    const token = (renew = false) =>
      appToken(
        key,
        async () => {
          const label = call('Feishu tenant token');
          const { status, body } = await exchange(
            fetch,
            `${base}/auth/v3/tenant_access_token/internal`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ app_id: config.appId, app_secret: secrets.appSecret }),
            },
            label,
          );
          const value = body?.tenant_access_token;
          if (status >= 300 || body?.code !== 0 || typeof value !== 'string') {
            throw failure(label, status, body?.code, body?.msg);
          }
          return { token: value, expiresInSeconds: typeof body.expire === 'number' ? body.expire : 7200 };
        },
        renew,
      );

    const client: ImClient = {
      async sendText(to, text) {
        for (let attempt = 0; ; attempt++) {
          const current = await token(attempt > 0);
          const label = call('Feishu message', [current]);
          const { status, body } = await exchange(
            fetch,
            `${base}/im/v1/messages?receive_id_type=open_id`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${current}` },
              body: JSON.stringify({ receive_id: to, msg_type: 'text', content: JSON.stringify({ text }) }),
            },
            label,
          );
          const code = typeof body?.code === 'number' ? body.code : null;
          if (status < 300 && code === 0) return;
          if (code !== null && TOKEN_DEAD.has(code) && attempt === 0) {
            forgetToken(key);
            continue;
          }
          if (code !== null && RECIPIENT_REFUSED.has(code)) {
            throw new UndeliverableError(`Feishu refused the recipient: ${code} ${String(body?.msg ?? '')}`.trim());
          }
          throw failure(label, status, code, body?.msg);
        }
      },
      async verify() {
        await token(true);
      },
    };
    return client;
  },
  test: (client) => client.verify(),
};
