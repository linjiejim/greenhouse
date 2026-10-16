/**
 * WeCom (企业微信) as a channel: the workspace's self-built app sends a member a text message by
 * their userid, with an access token (cached, renewed once when it dies early). Text, not
 * markdown, and angle brackets are the caller's to neutralise: WeCom reads `<a>` in text.
 */

import { z } from 'zod';
import { UndeliverableError, type ImClient, type ProviderAdapter } from '../types.js';
import { appKey, appToken, exchange, failure, forgetToken } from './shared.js';

const configSchema = z.object({
  baseUrl: z.string().url().default('https://qyapi.weixin.qq.com'),
  corpId: z.string().trim().min(1).max(64),
  agentId: z.coerce.number().int().positive(),
});
export type WeComConfig = z.infer<typeof configSchema>;

const TIMEOUT_MS = 15_000;
/** The cached access token died early (expired, or the secret was reset): get a new one, once. */
const TOKEN_DEAD = new Set([40014, 42001]);
/** Nobody of that id can get this app's messages. */
const RECIPIENT_REFUSED = new Set([81013, 60111, 40003]);

export const wecomAdapter: ProviderAdapter<'im', WeComConfig> = {
  capability: 'im',
  kind: 'wecom',
  label: '企业微信',
  configSchema: configSchema as z.ZodType<WeComConfig>,
  secretKeys: ['secret'],
  requiredSecrets: ['secret'],
  endpoints: (config) => [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const base = `${config.baseUrl.replace(/\/+$/, '')}/cgi-bin`;
    const key = appKey('wecom', base, config.corpId, String(config.agentId), secrets.secret ?? '');
    const call = (label: string, extra: string[] = []) => ({
      label,
      secrets: [secrets.secret, ...extra],
      timeoutMs: TIMEOUT_MS,
    });

    const token = (renew = false) =>
      appToken(
        key,
        async () => {
          const label = call('WeCom access token');
          const query = new URLSearchParams({ corpid: config.corpId, corpsecret: secrets.secret ?? '' });
          const { status, body } = await exchange(fetch, `${base}/gettoken?${query}`, { method: 'GET' }, label);
          const value = body?.access_token;
          if (status >= 300 || body?.errcode !== 0 || typeof value !== 'string') {
            throw failure(label, status, body?.errcode, body?.errmsg);
          }
          return { token: value, expiresInSeconds: typeof body.expires_in === 'number' ? body.expires_in : 7200 };
        },
        renew,
      );

    const client: ImClient = {
      async sendText(to, text) {
        for (let attempt = 0; ; attempt++) {
          const current = await token(attempt > 0);
          const label = call('WeCom message', [current]);
          const { status, body } = await exchange(
            fetch,
            `${base}/message/send?${new URLSearchParams({ access_token: current })}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json; charset=utf-8' },
              body: JSON.stringify({ touser: to, msgtype: 'text', agentid: config.agentId, text: { content: text } }),
            },
            label,
          );
          const code = typeof body?.errcode === 'number' ? body.errcode : null;
          // A send to someone outside the app's visible range succeeds, naming them as invalid.
          const invalid = typeof body?.invaliduser === 'string' && body.invaliduser.trim() !== '';
          if (status < 300 && code === 0 && !invalid) return;
          if (code !== null && TOKEN_DEAD.has(code) && attempt === 0) {
            forgetToken(key);
            continue;
          }
          if (invalid || (code !== null && RECIPIENT_REFUSED.has(code))) {
            throw new UndeliverableError(
              `WeCom refused the recipient: ${code ?? ''} ${String(body?.errmsg ?? 'invalid user')}`.trim(),
            );
          }
          throw failure(label, status, code, body?.errmsg);
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
