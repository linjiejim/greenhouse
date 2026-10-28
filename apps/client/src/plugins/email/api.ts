/**
 * Email plugin reads and writes (`/api/email`, plugins/email/api/routes.ts). Saves test the
 * connection first; a refused save answers the test with the provider's words, so writes keep
 * the `test` the plain ApiResult drops.
 */
import { api, del, get, networkMiss, seg, statusCode, type ApiMiss } from '../../api/client';
import type { ConnectionTest, EmailAccount, EmailPreset } from './model';

export const listAccounts = () => get<{ accounts: EmailAccount[] }>('/api/email/accounts');
export const listPresets = () => get<{ presets: EmailPreset[] }>('/api/email/presets');
export const removeAccount = (id: string) => del(`/api/email/accounts/${seg(id)}`);

export type AccountWrite =
  | { ok: true; account: EmailAccount; test: ConnectionTest | null }
  | (ApiMiss & { test: ConnectionTest | null });

async function write(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<AccountWrite> {
  try {
    const res = await api(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    let data: { account?: EmailAccount; test?: ConnectionTest; error?: unknown; code?: unknown } = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // an unreadable body reads as a refusal without words
    }
    const test = data.test ?? null;
    if (res.ok && data.account) return { ok: true, account: data.account, test };
    return {
      ok: false,
      status: res.status,
      code: typeof data.code === 'string' ? data.code : res.ok ? 'invalid_response' : statusCode(res.status),
      message: typeof data.error === 'string' ? data.error : '',
      test,
    };
  } catch (error) {
    return { ...networkMiss(error), test: null };
  }
}

export const createAccount = (body: unknown) => write('POST', '/api/email/accounts', body);
export const updateAccount = (id: string, body: unknown) => write('PUT', `/api/email/accounts/${seg(id)}`, body);
/** Re-tests a saved mailbox; the station records the verdict on the account either way. */
export const testAccount = (id: string) => write('POST', `/api/email/accounts/${seg(id)}/test`);
