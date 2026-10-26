/**
 * Email accounts API — per-user IMAP/SMTP mailbox bindings.
 *
 * The password only ever travels outbound: create/update accept it, nothing
 * returns it. An update that omits it keeps the stored one.
 */

import type { EmailAccountView, EmailConnectionTestResult } from '@greenhouse/types/email';
import { authFetch } from '@greenhouse/web/extension-kit';

export interface EmailAccountInput {
  email_address: string;
  display_name?: string | null;
  preset?: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  use_tls?: boolean;
  username?: string;
  password: string;
}

export type EmailAccountUpdate = Partial<Omit<EmailAccountInput, 'email_address' | 'preset' | 'password'>> & {
  password?: string;
};

/** Both failure branches carry `test`, so the caller can show which leg failed. */
export interface EmailAccountResult {
  account: EmailAccountView;
  test: EmailConnectionTestResult;
}

async function readError(res: Response): Promise<never> {
  const body = (await res.json().catch(() => ({}))) as { error?: string; test?: EmailConnectionTestResult };
  const detail = body.test
    ? [
        body.test.imap.ok ? null : `IMAP: ${body.test.imap.error}`,
        body.test.smtp.ok ? null : `SMTP: ${body.test.smtp.error}`,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  throw new Error([body.error ?? `Request failed (${res.status})`, detail].filter(Boolean).join(' — '));
}

export async function fetchEmailAccounts(): Promise<EmailAccountView[]> {
  const res = await authFetch('/api/email/accounts');
  if (!res.ok) return [];
  return (await res.json()).accounts as EmailAccountView[];
}

export async function fetchSharedMailbox(): Promise<{
  available: boolean;
  address: string | null;
  configured: boolean;
}> {
  const res = await authFetch('/api/email/shared');
  if (!res.ok) return { available: false, address: null, configured: false };
  return res.json();
}

export async function createEmailAccount(input: EmailAccountInput): Promise<EmailAccountResult> {
  const res = await authFetch('/api/email/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as EmailAccountResult;
}

export async function updateEmailAccount(id: string, input: EmailAccountUpdate): Promise<EmailAccountResult> {
  // Non-literal arg: hc only types `json` for validator-backed routes.
  const res = await authFetch(`/api/email/accounts/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) await readError(res);
  return (await res.json()) as EmailAccountResult;
}

export async function deleteEmailAccount(id: string): Promise<void> {
  const res = await authFetch(`/api/email/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) await readError(res);
}

export async function testEmailAccount(id: string): Promise<EmailAccountResult> {
  const res = await authFetch(`/api/email/accounts/${encodeURIComponent(id)}/test`, { method: 'POST' });
  if (!res.ok) await readError(res);
  return (await res.json()) as EmailAccountResult;
}
