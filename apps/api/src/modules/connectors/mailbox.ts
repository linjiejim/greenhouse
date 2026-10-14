/**
 * The built-in mailbox connector (OPEN-05, SET-05): a member's own mailbox over IMAP (imapflow)
 * and SMTP (nodemailer), offered to Agents through mcp_call like any connector.
 *
 * - Reaching it: the host is resolved first and every address must be public; outside production
 *   loopback is also allowed (a local test server), private networks never. The connection goes
 *   to the address checked, with the host name kept for TLS, so a second DNS answer cannot slip
 *   in. Plain text (`none`) only to loopback outside production.
 * - Tools: list_folders, search_messages and read_message only read; create_draft (an IMAP
 *   APPEND to Drafts) and send_message change things, so mcp_call raises a card for each
 *   (sending is tier 3). A read that cannot happen throws; it never reports an empty inbox.
 * - What a mailbox returns was written by strangers: mcp_call fences it as outside text; HTML
 *   becomes plain text here, and bodies are cut.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { ImapFlow, type FetchMessageObject, type ListResponse } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { createTransport } from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type SMTPTransport from 'nodemailer/lib/smtp-transport/index.js';
import type { MailSecurity } from '@greenhouse/contract';
import type { ConnectorToolSpec } from '@greenhouse/db';
import { cutText, htmlToText, parseAddress } from '@greenhouse/providers';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import { isPrivateAddress } from '../../security/network.js';
import type { NetworkMode } from './network.js';

export const MAILBOX_SLUG = 'mailbox';
/** Its id among connectors: never a database id. */
export const MAILBOX_CONNECTOR_ID = 'builtin:mailbox';

const TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 15_000;
const LIST_DEFAULT = 20;
const LIST_MAX = 50;
const BODY_MAX = 8_000;
const RECIPIENTS_MAX = 10;
const SUBJECT_MAX = 300;
const SEND_BODY_MAX = 20_000;
/** The largest message read back whole; a mailbox can hold anything. */
const MESSAGE_MAX_BYTES = 25 * 1024 * 1024;

export interface MailboxServer {
  host: string;
  port: number;
  security: MailSecurity;
}

/** What a connection keeps in `config`; the password is sealed apart. */
export interface MailboxSettings {
  address: string;
  displayName?: string;
  imap: MailboxServer;
  smtp: MailboxServer;
  username: string;
}

/** Thrown for every failure, so a caller never mistakes a failed read for an empty mailbox. */
export class MailboxError extends Error {
  constructor(
    message: string,
    /** The server refused the user name or password: the member must reconnect. */
    readonly authFailed = false,
  ) {
    super(message);
    this.name = 'MailboxError';
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
const isLoopbackAddress = (ip: string) => ip === '::1' || ip.startsWith('127.') || ip === '::ffff:127.0.0.1';

/**
 * Where to connect: the host's address, checked. Production allows public addresses only; other
 * modes also loopback, never a private network.
 */
export async function planHost(
  server: MailboxServer,
  mode: NetworkMode,
): Promise<{ address: string; servername: string }> {
  const host = server.host.toLowerCase();
  const local = mode !== 'production';
  if (server.security === 'none' && (!local || !(LOOPBACK.has(host) || host.endsWith('.localhost')))) {
    throw new MailboxError(`${host}: use TLS or STARTTLS; a password is never sent in plain text.`);
  }
  if (
    host.endsWith('.internal') ||
    host.endsWith('.local') ||
    (!local && (LOOPBACK.has(host) || host.endsWith('.localhost')))
  ) {
    throw new MailboxError(`${host} is not reachable from the server.`);
  }
  let addresses: string[];
  if (isIP(host)) addresses = [host];
  else {
    try {
      addresses = (await lookup(host, { all: true })).map((entry) => entry.address);
    } catch (error) {
      throw new MailboxError(`Cannot find the mail server ${host}: ${toErrorMessage(error)}`);
    }
  }
  const allowed = (ip: string) => !isPrivateAddress(ip) || (local && isLoopbackAddress(ip));
  if (!addresses.length || addresses.some((ip) => !allowed(ip))) {
    throw new MailboxError(`${host} points into a private network; use the mail server's public address.`);
  }
  return { address: addresses[0]!, servername: host };
}

/** imapflow says only "Command failed"; the server's own words are on `responseText`. */
function imapReason(error: unknown): string {
  const base = toErrorMessage(error);
  const detail = (error as { responseText?: unknown }).responseText;
  return typeof detail === 'string' && detail && !base.includes(detail) ? `${base}: ${detail}` : base;
}

const redactAll = (text: string, secrets: readonly string[]) =>
  secrets.reduce((out, secret) => (secret.length >= 4 ? out.split(secret).join('***') : out), text).slice(0, 500);

type Role = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive';

/** Names a model (or a person) uses for well-known folders, in English and Chinese. */
const ROLE_NAMES: Record<string, Role> = {
  inbox: 'inbox',
  收件箱: 'inbox',
  sent: 'sent',
  'sent items': 'sent',
  'sent messages': 'sent',
  已发送: 'sent',
  drafts: 'drafts',
  draft: 'drafts',
  草稿箱: 'drafts',
  trash: 'trash',
  'deleted items': 'trash',
  已删除: 'trash',
  junk: 'junk',
  spam: 'junk',
  垃圾邮件: 'junk',
  archive: 'archive',
  归档: 'archive',
};

function roleOf(box: Pick<ListResponse, 'path' | 'specialUse'>): Role | null {
  const special = (box.specialUse ?? '').replace('\\', '').toLowerCase();
  if (['sent', 'drafts', 'trash', 'junk', 'archive'].includes(special)) return special as Role;
  return box.path.toUpperCase() === 'INBOX' ? 'inbox' : null;
}

interface Address {
  name?: string;
  address?: string;
}

const addressText = (entry: Address | undefined) =>
  entry?.address ? (entry.name ? `${entry.name} <${entry.address}>` : entry.address) : undefined;

function addressList(value: AddressObject | AddressObject[] | undefined): string[] {
  if (!value) return [];
  const groups = Array.isArray(value) ? value : [value];
  return groups.flatMap((group) =>
    (group.value as Address[]).map(addressText).filter((entry): entry is string => !!entry),
  );
}

/** Recipients as given (`a@b.c` or `Name <a@b.c>`), each checked to be one address. */
const toList = (value: unknown, field: string): string[] => {
  const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return list.map((entry) => {
    const text = String(entry).trim();
    const parsed = parseAddress(text);
    if (!parsed) throw new MailboxError(`"${text}" in ${field} is not an email address.`);
    return parsed.name ? `${parsed.name.replace(/["\\]/g, '')} <${parsed.address}>` : parsed.address;
  });
};

/** One member's mailbox; every call opens and closes its own connections. */
export function mailboxClient(settings: MailboxSettings, password: string, mode: NetworkMode) {
  const secrets = [password];

  async function withImap<T>(work: (client: ImapFlow) => Promise<T>, timeoutMs = TIMEOUT_MS): Promise<T> {
    const plan = await planHost(settings.imap, mode);
    const client = new ImapFlow({
      host: plan.address,
      port: settings.imap.port,
      secure: settings.imap.security === 'tls',
      doSTARTTLS: settings.imap.security === 'starttls' ? true : settings.imap.security === 'none' ? false : undefined,
      servername: plan.servername,
      tls: { servername: plan.servername },
      auth: { user: settings.username, pass: password },
      logger: false,
      socketTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      connectionTimeout: timeoutMs,
      maxLiteralSize: MESSAGE_MAX_BYTES,
      maxResponseSize: MESSAGE_MAX_BYTES * 2,
    });
    // A failed connect can still emit an error later; without a listener it would end the process.
    client.on('error', (error: unknown) =>
      logger.info('[connectors] a mailbox socket failed after use', {
        error: redactAll(toErrorMessage(error), secrets),
      }),
    );
    try {
      await client.connect();
    } catch (error) {
      client.close();
      const failed = (error as { authenticationFailed?: unknown }).authenticationFailed === true;
      throw new MailboxError(
        redactAll(
          `IMAP ${settings.imap.host}: ${failed ? 'the user name or password was refused' : imapReason(error)}`,
          secrets,
        ),
        failed,
      );
    }
    try {
      return await work(client);
    } catch (error) {
      if (error instanceof MailboxError) throw error;
      throw new MailboxError(redactAll(`IMAP ${settings.imap.host}: ${imapReason(error)}`, secrets));
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  /** A folder the server has for a name the caller used: its path, its special use, or its name. */
  async function folderPath(client: ImapFlow, requested: string | undefined, fallback: Role = 'inbox') {
    const wanted = (requested ?? '').trim();
    const boxes = await client.list();
    if (!wanted && fallback === 'inbox') return 'INBOX';
    const exact = boxes.find((box) => box.path === wanted);
    if (exact) return exact.path;
    const role = wanted ? ROLE_NAMES[wanted.toLowerCase()] : fallback;
    const byRole = role && boxes.find((box) => roleOf(box) === role);
    if (byRole) return byRole.path;
    if (role === 'inbox') return 'INBOX';
    const byName = boxes.find((box) => box.name.toLowerCase() === wanted.toLowerCase());
    if (byName) return byName.path;
    throw new MailboxError(
      `There is no folder "${wanted || fallback}". The folders are: ${boxes.map((box) => box.path).join(', ')}.`,
    );
  }

  async function smtpTransport(timeoutMs = TIMEOUT_MS) {
    const plan = await planHost(settings.smtp, mode);
    const options: SMTPTransport.Options = {
      host: plan.address,
      port: settings.smtp.port,
      secure: settings.smtp.security === 'tls',
      requireTLS: settings.smtp.security === 'starttls',
      ignoreTLS: settings.smtp.security === 'none',
      tls: { servername: plan.servername },
      auth: { user: settings.username, pass: password },
      connectionTimeout: timeoutMs,
      greetingTimeout: timeoutMs,
      socketTimeout: timeoutMs,
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    return createTransport(options);
  }

  const sender = () =>
    settings.displayName ? { name: settings.displayName, address: settings.address } : settings.address;

  /** The message a reply answers: its subject and threading headers. */
  async function original(folder: string | undefined, uid: number) {
    return withImap(async (client) => {
      const path = await folderPath(client, folder);
      const lock = await client.getMailboxLock(path, { readOnly: true });
      try {
        const message = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
        if (!message || !message.source) throw new MailboxError(`There is no message ${uid} in ${path}.`);
        const parsed = await simpleParser(message.source);
        const references = Array.isArray(parsed.references)
          ? parsed.references
          : parsed.references
            ? [parsed.references]
            : [];
        return {
          subject: parsed.subject ?? '',
          messageId: parsed.messageId,
          references: [...references, ...(parsed.messageId ? [parsed.messageId] : [])].slice(-50),
          replyTo: addressList(parsed.replyTo).concat(addressList(parsed.from)).slice(0, 1),
        };
      } finally {
        lock.release();
      }
    });
  }

  const reSubject = (subject: string) => (/^re\s*:/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`);

  /** The mail a draft or a send writes, checked the same way for both. */
  async function compose(args: Record<string, unknown>) {
    const replyUid = typeof args.reply_to_uid === 'number' ? args.reply_to_uid : undefined;
    const answered = replyUid !== undefined ? await original(args.folder as string | undefined, replyUid) : null;
    const to = toList(args.to ?? answered?.replyTo, 'to');
    const cc = toList(args.cc, 'cc');
    const bcc = toList(args.bcc, 'bcc');
    if (!to.length) throw new MailboxError('Name at least one recipient in "to".');
    if (to.length + cc.length + bcc.length > RECIPIENTS_MAX) {
      throw new MailboxError(`At most ${RECIPIENTS_MAX} recipients per message.`);
    }
    const subject = String(args.subject ?? (answered ? reSubject(answered.subject) : '')).replace(/[\r\n]+/g, ' ');
    if (!subject.trim()) throw new MailboxError('Write a subject.');
    const body = String(args.body ?? '');
    if (!body.trim()) throw new MailboxError('Write the body.');
    return {
      from: sender(),
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      subject: cutText(subject, SUBJECT_MAX),
      text: cutText(body, SEND_BODY_MAX),
      ...(answered?.messageId ? { inReplyTo: answered.messageId } : {}),
      ...(answered?.references.length ? { references: answered.references } : {}),
    };
  }

  return {
    async listFolders() {
      return withImap(async (client) =>
        (await client.list()).map((box) => ({ path: box.path, name: box.name, role: roleOf(box) })),
      );
    },

    async search(args: Record<string, unknown>) {
      const limit = Math.min(Math.max(Number(args.limit ?? LIST_DEFAULT) || LIST_DEFAULT, 1), LIST_MAX);
      return withImap(async (client) => {
        const folder = await folderPath(client, args.folder as string | undefined);
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const criteria: Record<string, unknown> = {};
          const query = typeof args.query === 'string' ? args.query.trim() : '';
          if (query) criteria.or = [{ subject: query }, { from: query }, { body: query }];
          if (typeof args.since === 'string' && args.since) {
            const since = new Date(args.since);
            if (Number.isNaN(since.getTime())) throw new MailboxError(`"since" is not a date: ${args.since}`);
            criteria.since = since;
          }
          if (args.unseen_only === true) criteria.seen = false;
          if (!Object.keys(criteria).length) criteria.all = true;
          const uids = (await client.search(criteria, { uid: true })) || [];
          // Newest first; IMAP answers in ascending order.
          const chosen = uids.slice(-limit).reverse();
          if (!chosen.length) return { folder, messages: [] };
          const found: FetchMessageObject[] = [];
          for await (const message of client.fetch(chosen, { uid: true, envelope: true, flags: true }, { uid: true })) {
            found.push(message);
          }
          found.sort((a, b) => b.uid - a.uid);
          return {
            folder,
            messages: found.map((message) => ({
              uid: message.uid,
              from: addressText(message.envelope?.from?.[0]),
              to: (message.envelope?.to ?? []).map(addressText).filter(Boolean),
              subject: cutText(message.envelope?.subject ?? '(no subject)', 300),
              date: message.envelope?.date?.toISOString(),
              seen: !!message.flags?.has('\\Seen'),
            })),
          };
        } finally {
          lock.release();
        }
      });
    },

    async read(args: Record<string, unknown>) {
      const uid = Number(args.uid);
      if (!Number.isInteger(uid) || uid < 1) throw new MailboxError('Give the uid of a message from search_messages.');
      return withImap(async (client) => {
        const folder = await folderPath(client, args.folder as string | undefined);
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const message = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
          if (!message || !message.source) throw new MailboxError(`There is no message ${uid} in ${folder}.`);
          const parsed = await simpleParser(message.source);
          const html = typeof parsed.html === 'string' ? parsed.html : '';
          const text = parsed.text?.trim() ? parsed.text : html ? htmlToText(html) : '';
          return {
            uid,
            folder,
            from: addressList(parsed.from)[0],
            to: addressList(parsed.to),
            cc: addressList(parsed.cc),
            date: parsed.date?.toISOString(),
            subject: parsed.subject ?? '(no subject)',
            message_id: parsed.messageId,
            in_reply_to: parsed.inReplyTo,
            attachments: (parsed.attachments ?? []).map((part) => ({
              name: part.filename ?? '(unnamed)',
              content_type: part.contentType,
              size_bytes: part.size,
            })),
            body: cutText(text, BODY_MAX),
            ...(text.length > BODY_MAX ? { body_cut: true } : {}),
          };
        } finally {
          lock.release();
        }
      });
    },

    /** Saves a draft in the Drafts folder; nothing is sent. */
    async draft(args: Record<string, unknown>) {
      const mail = await compose(args);
      const raw = await new MailComposer({ ...mail, date: new Date() }).compile().build();
      return withImap(async (client) => {
        const folder = await folderPath(client, undefined, 'drafts');
        const appended = await client.append(folder, raw, ['\\Draft', '\\Seen']);
        return { saved: true, folder, ...(appended && appended.uid ? { uid: appended.uid } : {}), to: mail.to };
      });
    },

    async send(args: Record<string, unknown>) {
      const mail = await compose(args);
      const transport = await smtpTransport();
      try {
        const info = (await transport.sendMail(mail)) as { messageId?: string };
        return { sent: true, to: mail.to, message_id: info.messageId };
      } catch (error) {
        const failed = (error as { code?: unknown }).code === 'EAUTH';
        throw new MailboxError(redactAll(`SMTP ${settings.smtp.host}: ${toErrorMessage(error)}`, secrets), failed);
      } finally {
        transport.close();
      }
    },

    /** Both directions, each with its own verdict: a mailbox that cannot read never passes on sending alone. */
    async test(): Promise<{ imap: string | null; smtp: string | null; authFailed: boolean }> {
      let imap: string | null = null;
      let smtp: string | null = null;
      let authFailed = false;
      try {
        await withImap(async (client) => {
          await client.list();
        }, TEST_TIMEOUT_MS);
      } catch (error) {
        imap = toErrorMessage(error);
        authFailed ||= error instanceof MailboxError && error.authFailed;
      }
      try {
        const transport = await smtpTransport(TEST_TIMEOUT_MS);
        try {
          await transport.verify();
        } finally {
          transport.close();
        }
      } catch (error) {
        smtp = redactAll(
          error instanceof MailboxError ? error.message : `SMTP ${settings.smtp.host}: ${toErrorMessage(error)}`,
          secrets,
        );
        authFailed ||= (error as { code?: unknown }).code === 'EAUTH';
      }
      return { imap, smtp, authFailed };
    },
  };
}

const schema = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});
const folderField = {
  type: 'string',
  description: 'A folder path, or inbox, sent, drafts, trash, junk, archive. Default: the inbox.',
};
const recipients = (what: string) => ({
  type: 'array',
  items: { type: 'string' },
  maxItems: RECIPIENTS_MAX,
  description: what,
});
const outgoing = {
  to: recipients('Recipients. Leave out on a reply to answer its sender.'),
  cc: recipients('Copies.'),
  subject: { type: 'string', maxLength: SUBJECT_MAX, description: 'Leave out on a reply for "Re: <its subject>".' },
  body: { type: 'string', maxLength: SEND_BODY_MAX, description: 'The whole message as plain text, signed.' },
  reply_to_uid: { type: 'integer', description: 'The uid of the message this answers (threads the reply).' },
  folder: { ...folderField, description: 'The folder of reply_to_uid. Default: the inbox.' },
};

/** The connector's tools, as mcp_call lists them. */
export const MAILBOX_TOOLS: ConnectorToolSpec[] = [
  {
    name: 'list_folders',
    description: "List the folders of the member's mailbox.",
    inputSchema: schema({}),
    readOnly: true,
    destructive: false,
  },
  {
    name: 'search_messages',
    description:
      "Find messages in the member's mailbox, newest first: words in the subject, sender or body, a date, or only unread ones.",
    inputSchema: schema({
      folder: folderField,
      query: { type: 'string', maxLength: 200 },
      since: { type: 'string', description: 'Only messages on or after this date (YYYY-MM-DD).' },
      unseen_only: { type: 'boolean' },
      limit: { type: 'integer', minimum: 1, maximum: LIST_MAX },
    }),
    readOnly: true,
    destructive: false,
  },
  {
    name: 'read_message',
    description:
      'Read one message by the uid search_messages gave: sender, recipients, date, subject, text and attachment names.',
    inputSchema: schema({ uid: { type: 'integer', minimum: 1 }, folder: folderField }, ['uid']),
    readOnly: true,
    destructive: false,
  },
  {
    name: 'create_draft',
    description: "Save a draft in the member's Drafts folder for them to finish and send themselves. Nothing is sent.",
    inputSchema: schema(outgoing, ['body']),
    readOnly: false,
    destructive: false,
  },
  {
    name: 'send_message',
    description: "Send a message from the member's own address. It cannot be taken back.",
    inputSchema: schema({ ...outgoing, bcc: recipients('Blind copies.') }, ['body']),
    readOnly: false,
    destructive: false,
  },
];

/** Runs one of the tools with the member's mailbox; the text mcp_call passes on. */
export async function runMailboxTool(
  client: ReturnType<typeof mailboxClient>,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result =
    tool === 'list_folders'
      ? await client.listFolders()
      : tool === 'search_messages'
        ? await client.search(args)
        : tool === 'read_message'
          ? await client.read(args)
          : tool === 'create_draft'
            ? await client.draft(args)
            : tool === 'send_message'
              ? await client.send(args)
              : null;
  if (result === null) return { isError: true, text: `The mailbox has no tool "${tool}".` };
  return { isError: false, text: JSON.stringify(result, null, 1) };
}
