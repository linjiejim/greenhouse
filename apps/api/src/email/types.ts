/**
 * Email module types — the shapes the IMAP/SMTP client speaks.
 *
 * One provider, so this is a concrete contract rather than an interface layer
 * over multiple implementations (root AGENTS.md: no speculative abstraction).
 */

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailFolder {
  /** IMAP path, e.g. "INBOX" or "Sent Messages" — pass back verbatim. */
  path: string;
  name: string;
  /** Well-known role when the server flags one, otherwise undefined. */
  role?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';
  messages?: number;
  unseen?: number;
}

export interface EmailAttachmentInfo {
  filename: string;
  content_type: string;
  size_bytes: number;
}

export interface EmailSummary {
  /** IMAP UID, stable within a folder. */
  uid: number;
  folder: string;
  message_id?: string;
  subject: string;
  from?: EmailAddress;
  to: EmailAddress[];
  date?: string;
  seen: boolean;
  has_attachments: boolean;
  snippet?: string;
}

export interface EmailDetail extends EmailSummary {
  cc: EmailAddress[];
  body_text?: string;
  /** Present only before sanitization; never reaches the model. */
  body_html?: string;
  attachments: EmailAttachmentInfo[];
  in_reply_to?: string;
  references?: string[];
}

export interface EmailListOptions {
  folder?: string;
  limit?: number;
  /** Free-text search across subject/from/body; server-side IMAP SEARCH. */
  query?: string;
  /** Only messages received on or after this date (ISO or YYYY-MM-DD). */
  since?: string;
  unseen_only?: boolean;
}

export interface EmailAttachmentPayload {
  filename: string;
  content: Buffer;
  content_type?: string;
}

export interface SendEmailOptions {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body_text?: string;
  body_html?: string;
  in_reply_to?: string;
  references?: string[];
  attachments?: EmailAttachmentPayload[];
}

/** Everything needed to open a connection, decrypted and ready to use. */
export interface MailboxCredentials {
  email_address: string;
  display_name?: string | null;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  use_tls: boolean;
  use_proxy: boolean;
  username: string;
  password: string;
}

export interface ConnectionTestResult {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}
