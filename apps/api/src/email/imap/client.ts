/**
 * Generic IMAP/SMTP email client.
 *
 * Uses nodemailer for SMTP sending and raw IMAP for reading.
 * Supports QQ Mail, 163 Mail, corporate Exchange, etc.
 *
 * NOTE: This is a lightweight implementation using nodemailer's SMTP transport
 * for sending and IMAP for reading. For production-grade IMAP, consider imapflow.
 * Currently we use the IMAP built into Node.js-compatible libraries.
 */

import { createTransport } from 'nodemailer';
import { toErrorMessage } from '@greenhouse/utils/error';
import type {
  IEmailClient,
  EmailFolder,
  EmailListOptions,
  EmailListResult,
  EmailMessageDetail,
  SendEmailOptions,
  ImapCredentials,
} from '../types.js';
import { logger } from '@greenhouse/utils/logger';

export class ImapSmtpClient implements IEmailClient {
  constructor(
    private creds: ImapCredentials,
    private displayName?: string,
  ) {}

  async listFolders(): Promise<EmailFolder[]> {
    // For IMAP, return standard folders as a baseline
    // Full IMAP folder listing would require imapflow or similar
    return [
      { id: 'INBOX', name: 'Inbox', type: 'inbox' },
      { id: 'Sent', name: 'Sent', type: 'sent' },
      { id: 'Drafts', name: 'Drafts', type: 'drafts' },
      { id: 'Trash', name: 'Trash', type: 'trash' },
      { id: 'Junk', name: 'Spam', type: 'spam' },
    ];
  }

  async listMessages(_opts?: EmailListOptions): Promise<EmailListResult> {
    // IMAP message listing requires a full IMAP client library (e.g. imapflow)
    // This is a placeholder — Phase 2 will add imapflow for full IMAP support
    logger.warn('[IMAP] listMessages not yet implemented — requires imapflow library');
    return { messages: [] };
  }

  async getMessage(_messageId: string): Promise<EmailMessageDetail> {
    logger.warn('[IMAP] getMessage not yet implemented — requires imapflow library');
    throw new Error('IMAP message reading requires imapflow library (Phase 2)');
  }

  async sendEmail(opts: SendEmailOptions): Promise<{ messageId: string }> {
    const transport = createTransport({
      host: this.creds.smtp_host,
      port: this.creds.smtp_port,
      secure: this.creds.use_tls,
      auth: {
        user: this.creds.username,
        pass: this.creds.password,
      },
    });

    const fromAddress = this.displayName ? `"${this.displayName}" <${this.creds.username}>` : this.creds.username;

    const result = await transport.sendMail({
      from: fromAddress,
      to: opts.to.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', '),
      cc: opts.cc?.map((a) => (a.name ? `"${a.name}" <${a.address}>` : a.address)).join(', '),
      subject: opts.subject,
      text: opts.body_text,
      html: opts.body_html,
      inReplyTo: opts.in_reply_to,
      references: opts.references?.join(' '),
    });

    await transport.close();
    return { messageId: result.messageId ?? `imap-sent-${Date.now()}` };
  }

  /**
   * Test SMTP connection (used for the "Test Connection" button).
   */
  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      const transport = createTransport({
        host: this.creds.smtp_host,
        port: this.creds.smtp_port,
        secure: this.creds.use_tls,
        auth: {
          user: this.creds.username,
          pass: this.creds.password,
        },
        connectionTimeout: 10_000,
      });
      await transport.verify();
      await transport.close();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: toErrorMessage(err) };
    }
  }
}
