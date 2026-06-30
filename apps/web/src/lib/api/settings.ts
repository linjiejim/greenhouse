/**
 * Settings API — email accounts.
 */

import { rpc } from './client';

// ─── Email Accounts API ─────────────────────────────────

export interface EmailAccountInfo {
  id: number;
  user_id: string;
  provider: 'imap';
  email_address: string;
  display_name: string | null;
  config: string;
  status: 'active' | 'disabled' | 'auth_expired' | 'error';
  error_message: string | null;
  last_synced_at: string | null;
  created_at: string;
  updated_at: string;
}

export async function fetchEmailAccounts(showAll = false): Promise<EmailAccountInfo[]> {
  try {
    const res = await rpc.api.email.accounts.$get({ query: showAll ? { all: 'true' } : {} });
    if (!res.ok) return [];
    return (await res.json()).accounts ?? [];
  } catch {
    return [];
  }
}

export async function addImapEmailAccount(body: {
  email_address: string;
  display_name?: string;
  smtp_host: string;
  smtp_port: number;
  imap_host?: string;
  imap_port?: number;
  username: string;
  password: string;
  use_tls?: boolean;
}): Promise<{
  ok: boolean;
  // Server truth: POST /api/email/accounts returns a trimmed account
  // (id/provider/email_address/status/created_at), not the full row.
  account?: Pick<EmailAccountInfo, 'id' | 'provider' | 'email_address' | 'status' | 'created_at'>;
  error?: string;
}> {
  const res = await rpc.api.email.accounts.$post({ json: body });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Failed to add account' }));
    return { ok: false, error: err.error || `Failed: ${res.status}` };
  }
  const data = await res.json();
  return { ok: true, account: data.account };
}

// Server truth: DELETE returns { message } (it never had an `ok` field).
export async function deleteEmailAccount(id: number): Promise<{ message: string }> {
  const res = await rpc.api.email.accounts[':id'].$delete({ param: { id: String(id) } });
  if (!res.ok) throw new Error(`deleteEmailAccount failed: ${res.status}`);
  return res.json();
}

export async function testEmailAccount(id: number): Promise<{ ok: boolean; error?: string }> {
  const res = await rpc.api.email.accounts[':id'].test.$post({ param: { id: String(id) } });
  if (!res.ok) throw new Error(`testEmailAccount failed: ${res.status}`);
  return res.json();
}
