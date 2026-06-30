/**
 * Email service — constructs the IMAP/SMTP client for an account.
 *
 * Handles:
 * - Credential decryption
 * - IMAP/SMTP client instantiation
 */

import type { DatabaseProvider, EmailAccountRow } from '@greenhouse/db';
import { toErrorMessage } from '@greenhouse/utils/error';
import { decryptToken, encryptToken, isEncryptionConfigured } from '../auth/crypto.js';
import { ImapSmtpClient } from './imap/client.js';
import type { IEmailClient, ImapCredentials } from './types.js';
import { nowIso } from '@greenhouse/utils/date';

/** Max email accounts per user. */
export const MAX_EMAIL_ACCOUNTS = 10;

/**
 * Decrypt and parse credentials from an email account row.
 */
function decryptCredentials(encrypted: string): ImapCredentials {
  const json = decryptToken(encrypted);
  return JSON.parse(json);
}

/**
 * Encrypt credentials for storage.
 */
export function encryptCredentials(creds: ImapCredentials): string {
  return encryptToken(JSON.stringify(creds));
}

/**
 * Create an email client for a given account.
 */
export async function createEmailClient(_db: DatabaseProvider, account: EmailAccountRow): Promise<IEmailClient> {
  const creds = decryptCredentials(account.credentials);
  return new ImapSmtpClient(creds, account.display_name ?? undefined);
}

/**
 * Test connection for an email account.
 */
export async function testEmailConnection(
  db: DatabaseProvider,
  account: EmailAccountRow,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = await createEmailClient(db, account);

    if (client instanceof ImapSmtpClient) {
      const result = await client.testConnection();
      if (result.ok) {
        await db.emailAccounts.update(account.id, {
          status: 'active',
          error_message: null,
          last_synced_at: nowIso(),
        });
      } else {
        await db.emailAccounts.update(account.id, {
          status: 'error',
          error_message: result.error ?? 'Connection test failed',
        });
      }
      return result;
    }

    return { ok: false, error: 'Unknown provider' };
  } catch (err) {
    const msg = toErrorMessage(err);
    await db.emailAccounts.update(account.id, {
      status: 'error',
      error_message: msg,
    });
    return { ok: false, error: msg };
  }
}

/** Check if email encryption is properly configured. */
export { isEncryptionConfigured };
