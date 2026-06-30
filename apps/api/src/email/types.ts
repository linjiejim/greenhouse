/**
 * Email integration types — shared across all providers.
 */

// ─── Credential Shapes (before encryption) ──────────────

/** Generic IMAP/SMTP credentials (stored encrypted). */
export interface ImapCredentials {
  type: 'imap';
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  username: string;
  password: string; // app password
  use_tls: boolean;
}

export type EmailCredentials = ImapCredentials;

// ─── Email Data Types ────────────────────────────────────

export interface EmailFolder {
  id: string;
  name: string;
  type?: 'inbox' | 'sent' | 'drafts' | 'trash' | 'spam' | 'custom';
  unread_count?: number;
  total_count?: number;
}

export interface EmailAddress {
  name?: string;
  address: string;
}

export interface EmailMessageSummary {
  id: string;
  thread_id?: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  date: string; // ISO 8601
  snippet: string;
  is_read: boolean;
  has_attachments: boolean;
  labels?: string[];
}

export interface EmailMessageDetail extends EmailMessageSummary {
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  body_text?: string;
  body_html?: string;
  attachments?: EmailAttachment[];
  in_reply_to?: string;
  references?: string[];
}

export interface EmailAttachment {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
}

export interface SendEmailOptions {
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  subject: string;
  body_text?: string;
  body_html?: string;
  in_reply_to?: string; // message ID for reply
  references?: string[]; // thread message IDs
}

export interface EmailListOptions {
  folder?: string; // folder/label ID (default: INBOX)
  query?: string; // search query
  limit?: number; // max results (default: 20)
  page_token?: string; // pagination cursor
}

export interface EmailListResult {
  messages: EmailMessageSummary[];
  next_page_token?: string;
  total_estimate?: number;
}

// ─── Provider Interface ─────────────────────────────────

/** Unified interface for all email providers. */
export interface IEmailClient {
  /** List folders/labels. */
  listFolders(): Promise<EmailFolder[]>;
  /** List messages with pagination & search. */
  listMessages(opts?: EmailListOptions): Promise<EmailListResult>;
  /** Get full message detail. */
  getMessage(messageId: string): Promise<EmailMessageDetail>;
  /** Send an email. Returns the sent message ID. */
  sendEmail(opts: SendEmailOptions): Promise<{ messageId: string }>;
}
