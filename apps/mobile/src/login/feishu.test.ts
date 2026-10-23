import { describe, expect, it } from 'vitest';
import { FEISHU_APP_REDIRECT, feishuErrorKey, parseFeishuReturn } from './feishu';

describe('Feishu sign-in return', () => {
  it('reads the one-shot code or the reason from the app address only', () => {
    const code = 'a'.repeat(43);
    expect(parseFeishuReturn(`${FEISHU_APP_REDIRECT}?feishu_code=${code}`)).toEqual({ kind: 'code', code });
    expect(parseFeishuReturn(`${FEISHU_APP_REDIRECT}?feishu=error&reason=not_bound`)).toEqual({
      kind: 'error',
      reason: 'not_bound',
    });
    expect(parseFeishuReturn(`https://evil.example/?feishu_code=${code}`)).toEqual({ kind: 'cancel' });
    expect(parseFeishuReturn(`${FEISHU_APP_REDIRECT}?feishu_code=short`)).toEqual({ kind: 'cancel' });
    expect(parseFeishuReturn(null)).toEqual({ kind: 'cancel' });
  });

  it('names the reasons people can act on', () => {
    expect(feishuErrorKey('not_bound')).toBe('login.feishuNotBound');
    expect(feishuErrorKey('account_inactive')).toBe('login.feishuDisabled');
    expect(feishuErrorKey('state_expired')).toBe('login.feishuFailed');
  });

  it('matches the address the server allows', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const server = readFileSync(resolve(__dirname, '../../../api/src/routes/feishu-oauth.ts'), 'utf8');
    expect(server).toContain(`export const APP_LOGIN_REDIRECT = '${FEISHU_APP_REDIRECT}';`);
    const app = JSON.parse(readFileSync(resolve(__dirname, '../../app.json'), 'utf8')) as { expo: { scheme: string } };
    expect(FEISHU_APP_REDIRECT.startsWith(`${app.expo.scheme}://`)).toBe(true);
  });
});
