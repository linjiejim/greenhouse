import { z } from 'zod';
import { isoTime } from './common.js';

/**
 * Mail (providers.md §6 邮箱, PRD §8.4): system mail and every Agent's own mailbox through the
 * `mail` capability, and a member's own mailbox as a built-in connector.
 */

/** How a mail server is reached: TLS from the start, an upgrade to TLS, or plain (a local relay only). */
export const MAIL_SECURITY = ['tls', 'starttls', 'none'] as const;
export type MailSecurity = (typeof MAIL_SECURITY)[number];

/** A host name or an address, never a URL. */
const HOST = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
/** The part of an Agent's address before @: lower-case letters, digits, dots, dashes. */
export const MAILBOX_LOCAL_PART = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;
export const MAIL_DOMAIN =
  /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

const addressSchema = z.string().trim().toLowerCase().email().max(254);

export const mailAddressSchema = z.object({ address: z.string(), name: z.string().nullable() });
export type MailAddressView = z.infer<typeof mailAddressSchema>;

// ─── 管理 → 服务 → 邮箱 ──────────────────────────────────

/** A receiving instance and the address its vendor posts notices to. */
export const mailReceiverSchema = z.object({
  instance_id: z.string(),
  name: z.string(),
  kind: z.string(),
  /** Set this as the webhook (Resend) or the store(notify=…) address (Mailgun). */
  inbound_url: z.string(),
  /** It is first in the order: Agent mailboxes use it. */
  primary: z.boolean(),
});

export const adminMailSchema = z.object({
  /** Some instance can send: invites, resets and notification emails go out. */
  can_send: z.boolean(),
  /** The domain of Agent addresses, from MAIL_AGENT_DOMAIN or saved here; null when unset. */
  agent_domain: z.string().nullable(),
  /** Where it comes from: the environment (read-only until saved here) or this workspace. */
  agent_domain_source: z.enum(['env', 'workspace']).nullable(),
  /** MAIL_AGENT_DOMAIN, when set: what clearing the saved domain goes back to. */
  agent_domain_env: z.string().nullable(),
  /** Agent mailboxes exist: a receiving instance is first in the order and the domain is set. */
  mailboxes: z.boolean(),
  receivers: z.array(mailReceiverSchema),
});
export type AdminMail = z.infer<typeof adminMailSchema>;

export const updateAdminMailInputSchema = z
  .object({
    /** null goes back to MAIL_AGENT_DOMAIN (or none). */
    agent_domain: z
      .string()
      .trim()
      .toLowerCase()
      .regex(MAIL_DOMAIN, { message: 'Use a domain name, such as agents.example.com.' })
      .nullable(),
  })
  .strict();
export type UpdateAdminMailInput = z.input<typeof updateAdminMailInputSchema>;

/** A test mail to the admin themself, through the first instance that sends. */
export const mailTestSchema = z.object({
  ok: z.boolean(),
  instance: z.string().nullable(),
  latency_ms: z.number().int(),
  error: z.string().nullable(),
});
export type MailTest = z.infer<typeof mailTestSchema>;

// ─── Agent 邮箱 ──────────────────────────────────────────

export const MAILBOX_UNAVAILABLE = ['not_configured', 'public_agent', 'archived'] as const;

/** An address allowed to wake the Agent, besides its owner and (when on) the workspace's members. */
export const mailSenderSchema = z.object({ address: z.string(), created_at: isoTime });
export type MailSender = z.infer<typeof mailSenderSchema>;

/** An Agent's mailbox as its owner sees it; `available: false` says why there is none. */
export const mailboxSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false), reason: z.enum(MAILBOX_UNAVAILABLE) }),
  z.object({
    available: z.literal(true),
    address: z.string(),
    local_part: z.string(),
    domain: z.string(),
    /** Mail from active workspace members wakes the Agent (the owner's always does). */
    allow_members: z.boolean(),
    senders: z.array(mailSenderSchema),
    /** Mail kept back, waiting for the owner to let its sender in. */
    screened_count: z.number().int(),
  }),
]);
export type Mailbox = z.infer<typeof mailboxSchema>;

export const updateMailboxInputSchema = z
  .object({
    local_part: z
      .string()
      .trim()
      .toLowerCase()
      .regex(MAILBOX_LOCAL_PART, { message: 'Use 1–40 lower-case letters, digits, ".", "_" or "-".' }),
    allow_members: z.boolean(),
  })
  .partial()
  .strict();
export type UpdateMailboxInput = z.input<typeof updateMailboxInputSchema>;

export const addMailSenderInputSchema = z.object({ address: addressSchema }).strict();
export type AddMailSenderInput = z.input<typeof addMailSenderInputSchema>;

export const MAIL_DIRECTIONS = ['in', 'out'] as const;
/** in: screened (kept back) or delivered (in the thread); out: sending, sent or failed. */
export const MAIL_STATUSES = ['screened', 'delivered', 'sending', 'sent', 'failed'] as const;
/** Why mail was kept back. */
export const MAIL_SCREEN_REASONS = ['sender', 'unverified', 'public_agent', 'archived'] as const;

export const mailItemSchema = z.object({
  id: z.string(),
  agent_id: z.string(),
  direction: z.enum(MAIL_DIRECTIONS),
  status: z.enum(MAIL_STATUSES),
  screen_reason: z.enum(MAIL_SCREEN_REASONS).nullable(),
  from: mailAddressSchema,
  to: z.array(mailAddressSchema),
  cc: z.array(mailAddressSchema),
  subject: z.string(),
  /** The start of the text, one line. */
  preview: z.string(),
  attachment_count: z.number().int(),
  /** The sender passed SPF, DKIM or DMARC aligned with its address (incoming mail). */
  verified: z.boolean(),
  /** The conversation the mail's card is in. */
  conversation_id: z.string().nullable(),
  /** Received or sent. */
  at: isoTime,
});
export type MailItem = z.infer<typeof mailItemSchema>;

export const mailAttachmentSchema = z.object({
  name: z.string(),
  content_type: z.string(),
  size_bytes: z.number().int(),
  /** Inline images: the HTML refers to them as `cid:<content_id>`. */
  content_id: z.string().nullable(),
  inline: z.boolean(),
  /** A signed link for the reader; null when it was left out (too large, too many). */
  url: z.string().nullable(),
  skipped: z.enum(['too_large', 'too_many', 'unavailable']).nullable(),
});

export const mailDetailSchema = mailItemSchema.extend({
  reply_to: z.array(mailAddressSchema),
  text: z.string(),
  /** As the sender wrote it: clients sanitise it before showing it, and load no remote images unasked. */
  html: z.string().nullable(),
  attachments: z.array(mailAttachmentSchema),
  message_id: z.string().nullable(),
  in_reply_to: z.string().nullable(),
  auth: z.object({ spf: z.string(), dkim: z.string(), dmarc: z.string() }),
  error: z.string().nullable(),
});
export type MailDetail = z.infer<typeof mailDetailSchema>;

export const mailListQuerySchema = z.object({
  status: z.enum(MAIL_STATUSES).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Letting a sender in: their waiting mail is delivered into the thread. */
export const mailReleaseSchema = z.object({ delivered: z.number().int(), sender: z.string() });
export type MailRelease = z.infer<typeof mailReleaseSchema>;

// ─── 设置 → 连接 · 个人邮箱 (the built-in connector) ─────────────

const serverSchema = z.object({
  host: z.string().trim().toLowerCase().regex(HOST, { message: 'Use a host name, such as imap.example.com.' }),
  port: z.number().int().min(1).max(65_535),
  security: z.enum(MAIL_SECURITY),
});

/** Connect my own mailbox: checked over IMAP and SMTP before anything is kept. */
export const connectMailboxInputSchema = z
  .object({
    kind: z.literal('email'),
    address: addressSchema,
    display_name: z.string().trim().max(100).optional(),
    imap: serverSchema,
    smtp: serverSchema,
    /** Defaults to the address. */
    username: z.string().trim().min(1).max(255).optional(),
    password: z.string().min(1).max(1024),
  })
  .strict();
export type ConnectMailboxInput = z.input<typeof connectMailboxInputSchema>;

/** The settings of a connected mailbox; the password never leaves the server. */
export const mailboxSettingsSchema = z.object({
  address: z.string(),
  imap: z.object({ host: z.string(), port: z.number().int(), security: z.enum(MAIL_SECURITY) }),
  smtp: z.object({ host: z.string(), port: z.number().int(), security: z.enum(MAIL_SECURITY) }),
  username: z.string(),
});
export type MailboxSettings = z.infer<typeof mailboxSettingsSchema>;
