/**
 * Generic IMAP/SMTP mailbox client — imapflow for reading, nodemailer for sending.
 *
 * Reading is a NEW implementation. Every previous version of this module in the
 * repo (and in the OSS fork) shipped `listMessages()` as a stub that logged a
 * warning and returned an empty array, so an IMAP account could only send. That
 * failure mode is the worst kind: the agent reports an empty inbox instead of
 * an error. Here a read that cannot happen throws.
 *
 * Egress: connections either go direct (with the resolved address checked
 * against the public-IP guard, closing the DNS-rebinding window) or through
 * MAIL_EGRESS_PROXY. Gmail is unreachable from the CN host without the latter.
 */

import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import { lookup as dnsLookup } from 'node:dns/promises';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';
import { isPublicNetworkAddress } from '../security/network.js';
import { CONNECTION_TEST_TIMEOUT_MS, DEFAULT_LIST_LIMIT, IMAP_TIMEOUT_MS, MAX_LIST_LIMIT } from './limits.js';
import type {
  ConnectionTestResult,
  EmailAddress,
  EmailDetail,
  EmailFolder,
  EmailListOptions,
  EmailSummary,
  MailboxCredentials,
  SendEmailOptions,
} from './types.js';

/** Thrown for every operational failure so callers never see a silent empty result. */
export class MailboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailboxError';
  }
}

/**
 * imapflow's command failures all say "Command failed"; the server's actual
 * rejection reason (e.g. "LOGIN Login error user name or password error") is on
 * `responseText`. Without it a wrong app password and a protocol error read
 * identically to the user.
 */
export function describeImapError(err: unknown): string {
  const base = toErrorMessage(err);
  const detail = (err as { responseText?: unknown }).responseText;
  return typeof detail === 'string' && detail.length > 0 && !base.includes(detail)
    ? `${base} — server said: ${detail}`
    : base;
}

/**
 * An ImapFlow instance whose connect() has already rejected can still emit
 * 'error' later (its socket timeout keeps ticking on the half-open socket).
 * With no listener, Node treats that as an uncaught exception and KILLS THE
 * PROCESS — on dev every failed mailbox binding took the whole API down ~15s
 * after the 400 response went out. Attach before connect, never after.
 */
export function guardImapClientErrors(client: ImapFlow, emailAddress: string): void {
  client.on('error', (err) => {
    logger.warn(`[Email] IMAP socket error for ${emailAddress} (ignored): ${toErrorMessage(err)}`);
  });
}

// ─── Egress ──────────────────────────────────────────────

function getProxyUrl(): string | undefined {
  const raw = process.env.MAIL_EGRESS_PROXY?.trim();
  return raw ? raw : undefined;
}

/**
 * Resolve a hostname and refuse anything that is not a public address.
 *
 * Returns the resolved IP so the caller can connect to THAT address while still
 * presenting the original hostname for TLS — resolving and connecting to the
 * same answer is what makes this a real check rather than a pre-flight one a
 * second DNS reply could invalidate.
 */
async function resolvePublicAddress(host: string): Promise<string> {
  // A literal address needs no lookup, just the same verdict.
  if (isPublicNetworkAddress(host)) return host;

  let resolved: Array<{ address: string }>;
  try {
    resolved = await dnsLookup(host, { all: true });
  } catch (err) {
    throw new MailboxError(`Cannot resolve mail host "${host}": ${toErrorMessage(err)}`);
  }
  if (resolved.length === 0 || resolved.some((r) => !isPublicNetworkAddress(r.address))) {
    throw new MailboxError(
      `Mail host "${host}" resolves to a non-public address — refusing to connect. Use a reachable public mail server.`,
    );
  }
  return resolved[0]!.address;
}

/**
 * Decide how to reach a host. Both direct and proxy connections resolve and pin
 * one public address here. Passing the original hostname to a SOCKS proxy would
 * move DNS resolution past this trust boundary and re-open private-host SSRF.
 */
export async function planConnection(
  host: string,
  useProxy: boolean,
): Promise<{ host: string; servername: string; proxy?: string }> {
  const address = await resolvePublicAddress(host);
  if (!useProxy) return { host: address, servername: host };

  const proxy = getProxyUrl();
  if (!proxy) {
    throw new MailboxError(
      'This account is configured to use the mail egress proxy, but MAIL_EGRESS_PROXY is not set on the server. Ask an admin to configure it (or turn the proxy option off for a directly reachable mailbox).',
    );
  }
  return { host: address, servername: host, proxy };
}

// ─── Address helpers ─────────────────────────────────────

interface ParsedAddressLike {
  name?: string;
  address?: string;
}

function toEmailAddress(value: ParsedAddressLike | undefined): EmailAddress | undefined {
  if (!value?.address) return undefined;
  return value.name ? { name: value.name, address: value.address } : { address: value.address };
}

function toEmailAddresses(value: AddressObject | AddressObject[] | ParsedAddressLike[] | undefined): EmailAddress[] {
  if (!value) return [];
  const list: ParsedAddressLike[] = Array.isArray(value)
    ? value.flatMap((entry) => ('value' in entry ? (entry.value as ParsedAddressLike[]) : [entry]))
    : ((value.value ?? []) as ParsedAddressLike[]);
  return list.map(toEmailAddress).filter((a): a is EmailAddress => a !== undefined);
}

function formatAddress(addr: EmailAddress): string {
  return addr.name ? `"${addr.name.replace(/"/g, '')}" <${addr.address}>` : addr.address;
}

// ─── Client ──────────────────────────────────────────────

export class ImapSmtpClient {
  constructor(private readonly creds: MailboxCredentials) {}

  // ── IMAP ──

  private async withImap<T>(fn: (client: ImapFlow) => Promise<T>, timeoutMs = IMAP_TIMEOUT_MS): Promise<T> {
    const plan = await planConnection(this.creds.imap_host, this.creds.use_proxy);
    const client = new ImapFlow({
      host: plan.host,
      port: this.creds.imap_port,
      secure: this.creds.use_tls,
      auth: { user: this.creds.username, pass: this.creds.password },
      proxy: plan.proxy,
      tls: { servername: plan.servername },
      // imapflow logs every command at info level; ours only needs failures.
      logger: false,
      socketTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      connectionTimeout: timeoutMs,
    });
    guardImapClientErrors(client, this.creds.email_address);

    try {
      await client.connect();
    } catch (err) {
      // connect() rejecting does not guarantee the socket is torn down.
      client.close();
      throw new MailboxError(`IMAP connection failed for ${this.creds.email_address}: ${describeImapError(err)}`);
    }

    try {
      return await fn(client);
    } catch (err) {
      // Every command failure imapflow raises says only "Command failed"; the
      // server's actual reason lives on `responseText`. Wrapping here rather
      // than at each call site means no IMAP path can lose it by omission —
      // that is how a bare "Command failed" reached the friction queue.
      if (err instanceof MailboxError) throw err;
      throw new MailboxError(`IMAP command failed for ${this.creds.email_address}: ${describeImapError(err)}`);
    } finally {
      // logout() can reject on a half-closed socket; that must not mask a result.
      await client.logout().catch(() => client.close());
    }
  }

  /**
   * Resolve a folder the caller named to a path this server actually has.
   *
   * IMAP folder paths are server-specific: the sent folder is `Sent` on one
   * host, `Sent Messages` on another, `&XfJT0ZAB-` on a Chinese provider. The
   * model can only reasonably say "Sent", so a literal `getMailboxLock('Sent')`
   * fails on most mailboxes — which is exactly what it did, as an unexplained
   * "Command failed". Matching by SPECIAL-USE first is what makes the logical
   * name work anywhere; an exact path still wins so callers echoing a path from
   * `listFolders` are never second-guessed.
   */
  private async resolveFolderPath(client: ImapFlow, requested: string): Promise<string> {
    const wanted = requested.trim();
    if (!wanted || wanted.toUpperCase() === 'INBOX') return 'INBOX';

    let boxes: MailboxListEntry[];
    try {
      boxes = (await client.list()) as MailboxListEntry[];
    } catch {
      // Listing is a convenience here; if it fails, let the original name try.
      return wanted;
    }

    const exact = boxes.find((box) => box.path === wanted);
    if (exact) return exact.path;

    const role = FOLDER_ROLE_ALIASES[wanted.toLowerCase()];
    const byRole = role && boxes.find((box) => normalizeFolderRole(box) === role);
    if (byRole) return byRole.path;

    const byName = boxes.find((box) => box.name.toLowerCase() === wanted.toLowerCase());
    if (byName) return byName.path;

    // Nothing matched: fail with the available paths rather than letting the
    // server answer "Command failed" for a name that was never going to work.
    throw new MailboxError(
      `No folder "${wanted}" in this mailbox. Available folders: ${boxes.map((b) => b.path).join(', ')}.`,
    );
  }

  async listFolders(): Promise<EmailFolder[]> {
    return await this.withImap(async (client) => {
      const list = await client.list();
      return list.map((box) => ({
        path: box.path,
        name: box.name,
        role: normalizeFolderRole(box),
        messages: undefined,
        unseen: undefined,
      }));
    });
  }

  async listMessages(opts: EmailListOptions = {}): Promise<EmailSummary[]> {
    const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);

    return await this.withImap(async (client) => {
      const folder = await this.resolveFolderPath(client, opts.folder || 'INBOX');
      const lock = await client.getMailboxLock(folder);
      try {
        const criteria: Record<string, unknown> = {};
        if (opts.query) criteria.or = [{ subject: opts.query }, { from: opts.query }, { body: opts.query }];
        if (opts.since) {
          const since = new Date(opts.since);
          if (Number.isNaN(since.getTime())) throw new MailboxError(`Invalid "since" date: ${opts.since}`);
          criteria.since = since;
        }
        if (opts.unseen_only) criteria.seen = false;
        if (Object.keys(criteria).length === 0) criteria.all = true;

        const uids = await client.search(criteria, { uid: true });
        if (!uids || uids.length === 0) return [];

        // Newest first, then page — IMAP hands back ascending UIDs.
        const selected = uids.slice(-limit).reverse();
        const summaries: EmailSummary[] = [];
        for await (const msg of client.fetch(
          selected,
          { uid: true, envelope: true, flags: true, bodyStructure: true },
          { uid: true },
        )) {
          summaries.push(toSummary(msg, folder));
        }
        // fetch() returns ascending regardless of the order requested.
        return summaries.sort((a, b) => b.uid - a.uid);
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(requestedFolder: string, uid: number): Promise<EmailDetail> {
    return await this.withImap(async (client) => {
      const folder = await this.resolveFolderPath(client, requestedFolder);
      const lock = await client.getMailboxLock(folder);
      try {
        const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
        if (!msg || !msg.source) {
          throw new MailboxError(`Message uid ${uid} not found in folder "${folder}".`);
        }
        const parsed = await simpleParser(msg.source);
        return {
          uid,
          folder,
          message_id: parsed.messageId,
          subject: parsed.subject ?? '(no subject)',
          from: toEmailAddresses(parsed.from)[0],
          to: toEmailAddresses(parsed.to),
          cc: toEmailAddresses(parsed.cc),
          date: parsed.date?.toISOString(),
          seen: Boolean(msg.flags?.has('\\Seen')),
          has_attachments: (parsed.attachments?.length ?? 0) > 0,
          body_text: parsed.text ?? undefined,
          body_html: typeof parsed.html === 'string' ? parsed.html : undefined,
          attachments: (parsed.attachments ?? []).map((a) => ({
            filename: a.filename ?? '(unnamed)',
            content_type: a.contentType ?? 'application/octet-stream',
            size_bytes: a.size ?? 0,
          })),
          in_reply_to: parsed.inReplyTo,
          references: normalizeReferences(parsed.references),
        };
      } finally {
        lock.release();
      }
    });
  }

  // ── SMTP ──

  private async createTransport(timeoutMs?: number): Promise<Transporter> {
    const plan = await planConnection(this.creds.smtp_host, this.creds.use_proxy);
    const options: SMTPTransport.Options = {
      host: plan.host,
      port: this.creds.smtp_port,
      secure: this.creds.use_tls,
      auth: { user: this.creds.username, pass: this.creds.password },
      tls: { servername: plan.servername },
      ...(timeoutMs ? { connectionTimeout: timeoutMs, greetingTimeout: timeoutMs, socketTimeout: timeoutMs } : {}),
    };
    const transport = createTransport(options);

    if (plan.proxy) {
      // HTTP CONNECT is built in; socks5:// needs the module handed over first
      // (nodemailer looks it up by name when the handler fires).
      if (plan.proxy.startsWith('socks')) {
        const socks = await import('socks');
        transport.set('proxy_socks_module', socks);
      }
      transport.setupProxy(plan.proxy);
    }
    return transport;
  }

  async sendEmail(opts: SendEmailOptions): Promise<{ messageId: string }> {
    const transport = await this.createTransport();
    const from = this.creds.display_name
      ? `"${this.creds.display_name}" <${this.creds.email_address}>`
      : this.creds.email_address;

    try {
      const result = await transport.sendMail({
        from,
        to: opts.to.map(formatAddress).join(', '),
        cc: opts.cc?.length ? opts.cc.map(formatAddress).join(', ') : undefined,
        bcc: opts.bcc?.length ? opts.bcc.map(formatAddress).join(', ') : undefined,
        subject: opts.subject,
        text: opts.body_text,
        html: opts.body_html,
        inReplyTo: opts.in_reply_to,
        references: opts.references?.join(' '),
        attachments: opts.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.content_type,
        })),
      });
      return { messageId: result.messageId ?? `sent-${result.response ?? 'ok'}` };
    } catch (err) {
      throw new MailboxError(`SMTP send failed from ${this.creds.email_address}: ${toErrorMessage(err)}`);
    } finally {
      transport.close();
    }
  }

  /**
   * Verify BOTH directions and report them separately.
   *
   * The deleted module only ever verified SMTP, which is how an account that
   * could not read a single message still passed its own connection test.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    const result: ConnectionTestResult = { imap: { ok: false }, smtp: { ok: false } };

    try {
      await this.withImap(async (client) => {
        await client.list();
      }, CONNECTION_TEST_TIMEOUT_MS);
      result.imap = { ok: true };
    } catch (err) {
      result.imap = { ok: false, error: toErrorMessage(err) };
    }

    let transport: Transporter | undefined;
    try {
      transport = await this.createTransport(CONNECTION_TEST_TIMEOUT_MS);
      await transport.verify();
      result.smtp = { ok: true };
    } catch (err) {
      result.smtp = { ok: false, error: toErrorMessage(err) };
    } finally {
      transport?.close();
    }

    if (!result.imap.ok || !result.smtp.ok) {
      logger.warn(
        `[Email] Connection test for ${this.creds.email_address}: imap=${result.imap.ok} smtp=${result.smtp.ok}`,
      );
    }
    return result;
  }
}

// ─── Shape mapping ───────────────────────────────────────

interface MailboxListEntry {
  path: string;
  name: string;
  specialUse?: string;
  flags?: Set<string>;
}

/**
 * The names a caller may reasonably use for a well-known folder, mapped to the
 * SPECIAL-USE role that identifies it on any server. Both the English word and
 * the Chinese label appear because both mailboxes and models produce both.
 */
const FOLDER_ROLE_ALIASES: Record<string, EmailFolder['role']> = {
  sent: 'sent',
  'sent items': 'sent',
  'sent messages': 'sent',
  已发送: 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  草稿箱: 'drafts',
  trash: 'trash',
  deleted: 'trash',
  'deleted items': 'trash',
  已删除: 'trash',
  junk: 'junk',
  spam: 'junk',
  垃圾邮件: 'junk',
  archive: 'archive',
  归档: 'archive',
};

function normalizeFolderRole(box: MailboxListEntry): EmailFolder['role'] {
  const special = (box.specialUse ?? '').replace('\\', '').toLowerCase();
  switch (special) {
    case 'sent':
      return 'sent';
    case 'drafts':
      return 'drafts';
    case 'trash':
      return 'trash';
    case 'junk':
      return 'junk';
    case 'archive':
      return 'archive';
    default:
      return box.path.toUpperCase() === 'INBOX' ? 'inbox' : undefined;
  }
}

interface FetchedMessage {
  uid: number;
  flags?: Set<string>;
  envelope?: {
    messageId?: string;
    subject?: string;
    from?: ParsedAddressLike[];
    to?: ParsedAddressLike[];
    date?: Date;
  };
  bodyStructure?: { childNodes?: unknown[]; disposition?: string };
}

function toSummary(msg: FetchedMessage, folder: string): EmailSummary {
  const env = msg.envelope ?? {};
  return {
    uid: msg.uid,
    folder,
    message_id: env.messageId,
    subject: env.subject ?? '(no subject)',
    from: toEmailAddress(env.from?.[0]),
    to: toEmailAddresses(env.to),
    date: env.date instanceof Date ? env.date.toISOString() : undefined,
    seen: Boolean(msg.flags?.has('\\Seen')),
    has_attachments: hasAttachment(msg.bodyStructure),
  };
}

function hasAttachment(node: FetchedMessage['bodyStructure']): boolean {
  if (!node) return false;
  if (node.disposition === 'attachment') return true;
  const children = (node.childNodes ?? []) as FetchedMessage['bodyStructure'][];
  return children.some((child) => hasAttachment(child));
}

function normalizeReferences(refs: string | string[] | undefined): string[] | undefined {
  if (!refs) return undefined;
  return Array.isArray(refs) ? refs : [refs];
}
