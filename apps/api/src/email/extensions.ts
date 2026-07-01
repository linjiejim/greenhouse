/**
 * Fork extension point for email connectors.
 *
 * Upstream ships IMAP/SMTP only (see service.ts). A downstream fork that needs
 * Gmail/Outlook (OAuth) registers a connector keyed by the account's `provider`
 * at startup via registerEmailConnector() — from bootstrap.extensions.ts —
 * WITHOUT editing service.ts. `createEmailClient` dispatches to a registered
 * connector for a non-`imap` provider, else falls back to the IMAP client.
 * No connectors upstream.
 *
 * (The core `email_accounts.provider` column is typed `'imap'`; a fork storing
 * `'gmail'`/`'outlook'` casts at its own insert boundary — the DB column is
 * plain text, and this registry is keyed by string.)
 *
 * Fork example (called from bootstrapForkExtensions()):
 *   registerEmailConnector('gmail', async (db, account) => new GmailClient(...));
 */

import type { DatabaseProvider, EmailAccountRow } from '@greenhouse/db';
import type { IEmailClient } from './types.js';

export type EmailConnectorFactory = (db: DatabaseProvider, account: EmailAccountRow) => Promise<IEmailClient>;

const connectors = new Map<string, EmailConnectorFactory>();

/** Register an email connector for a provider (e.g. 'gmail', 'outlook'). */
export function registerEmailConnector(provider: string, factory: EmailConnectorFactory): void {
  connectors.set(provider, factory);
}

export function getEmailConnector(provider: string): EmailConnectorFactory | undefined {
  return connectors.get(provider);
}
