/**
 * Mailgun as the `mail` capability: sends through its HTTP API and receives through a Route whose
 * action is `store(notify="<PUBLIC_URL>/api/mail/inbound/<instance>")` (providers.md §6 邮箱).
 *
 * - Sending: POST /v3/<domain>/messages (form fields; `h:` headers for threading), Basic auth `api:<key>`.
 * - Receiving: the notify POST carries `timestamp`, `token` and `signature` = hex HMAC-SHA256 of
 *   timestamp + token with the webhook signing key. The signature covers nothing else, so the
 *   notice is only a signal: its `message-url` must be a stored message of this instance's domain
 *   on a Mailgun address, and the mail is fetched from there with the key. Tokens are single use
 *   (the API remembers them); the parsed fields Mailgun also posts are never read.
 * - Verdicts come from the headers Mailgun's receiving server adds (`X-Mailgun-Spf`,
 *   `X-Mailgun-Dkim-Check-Result`), trusted only when each appears once: a sender can write the
 *   same header into the mail, and a second copy means someone tried.
 * - The key goes only to the base URL and Mailgun's storage hosts (`https://*.api.mailgun.net`).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getJson, ProviderRequestError, send, withoutTrailingSlash } from '../http.js';
import { isPinned } from '../pinned-fetch.js';
import {
  MailSignatureError,
  UndeliverableError,
  type InboundAttachment,
  type InboundMail,
  type MailClient,
  type MailReceiver,
  type ProviderAdapter,
} from '../types.js';
import {
  AttachmentBudget,
  contentTypeOf,
  cut,
  dkimDomainsOf,
  fileNameOf,
  formatAddress,
  headerValues,
  htmlToText,
  MAIL_LIMITS,
  messageIdOf,
  oneLine,
  parseAddress,
  parseAddressList,
  readCapped,
  referencesOf,
  singleVerdict,
} from './shared.js';

export const MAILGUN_API = 'https://api.mailgun.net';
export const MAILGUN_EU_API = 'https://api.eu.mailgun.net';
/** Mailgun keeps stored messages on storage-<region>.api.mailgun.net, for both regions. */
const MAILGUN_STORAGE = 'https://*.api.mailgun.net';
const MAILGUN_HOSTS = new Set(['api.mailgun.net', 'api.eu.mailgun.net']);

const HOST = /^[a-z0-9](?:[a-z0-9.-]{0,253}[a-z0-9])?$/;

const configSchema = z.object({
  baseUrl: z.string().url().default(MAILGUN_API),
  /** The sending and receiving domain set up at Mailgun. */
  domain: z.string().trim().toLowerCase().regex(HOST, { message: 'Use a domain name, such as mg.example.com.' }),
  /** The sender of system mail (invites, resets, notifications). */
  fromAddress: z.string().trim().email(),
  fromName: z.string().trim().min(1).max(100).optional(),
});
export type MailgunConfig = z.infer<typeof configSchema>;

const TIMEOUT_MS = 20_000;
/** Mailgun retries a notice for hours, signed when it was first sent: that long, and remembered past it. */
const TOLERANCE_SECONDS = 12 * 60 * 60;
const NONCE_TTL_SECONDS = 13 * 60 * 60;
/** The notify POST also carries the parsed mail (and may carry its attachments), never read here. */
const MAX_NOTICE_BYTES = 40 * 1024 * 1024;

/** Checks a Mailgun signature: the hex HMAC of timestamp + token with the webhook signing key. */
export function verifyMailgun(input: {
  signingKey: string;
  timestamp: string;
  token: string;
  signature: string;
  now: number;
}): void {
  if (!/^\d{1,12}$/.test(input.timestamp) || !/^[A-Za-z0-9]{20,128}$/.test(input.token)) {
    throw new MailSignatureError('The notice is not signed.');
  }
  if (Math.abs(input.now - Number(input.timestamp)) > TOLERANCE_SECONDS) {
    throw new MailSignatureError('The notice is too old or from the future.');
  }
  if (!input.signingKey) throw new MailSignatureError('The webhook signing key is not set.');
  const expected = createHmac('sha256', input.signingKey).update(`${input.timestamp}${input.token}`).digest();
  const given = /^[0-9a-f]{64}$/i.test(input.signature) ? Buffer.from(input.signature, 'hex') : Buffer.alloc(0);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new MailSignatureError('The signature does not match.');
  }
}

/** The notice's fields, from a form (urlencoded or multipart) or JSON body. */
async function noticeFields(headers: Headers, body: Uint8Array): Promise<Record<string, string>> {
  const type = (headers.get('content-type') ?? '').toLowerCase();
  const out: Record<string, string> = {};
  if (type.includes('application/json')) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
    } catch {
      throw new MailSignatureError('The notice is not readable.');
    }
    const nested = parsed.signature && typeof parsed.signature === 'object' ? parsed.signature : null;
    for (const [key, value] of Object.entries({ ...parsed, ...(nested as object) })) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  }
  if (!type.includes('multipart/form-data') && !type.includes('application/x-www-form-urlencoded')) {
    throw new MailSignatureError('The notice is not a form.');
  }
  let form: FormData;
  try {
    form = await new Response(Buffer.from(body), {
      headers: { 'content-type': headers.get('content-type')! },
    }).formData();
  } catch {
    throw new MailSignatureError('The notice is not readable.');
  }
  for (const key of ['timestamp', 'token', 'signature', 'message-url']) {
    const value = form.get(key);
    if (typeof value === 'string') out[key] = value;
  }
  return out;
}

interface StoredMessage {
  recipients?: unknown;
  sender?: unknown;
  from?: unknown;
  subject?: unknown;
  'body-plain'?: unknown;
  'body-html'?: unknown;
  'message-headers'?: unknown;
  attachments?: unknown;
}

/** `message-headers`: a list of [name, value] pairs (a JSON string in some answers). */
function headerPairs(raw: unknown): [string, string][] {
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is [string, string] =>
        Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string',
    )
    .slice(0, 1000)
    .map(([name, text]) => [name, text.slice(0, 20_000)]);
}

export const mailgunAdapter: ProviderAdapter<'mail', MailgunConfig> = {
  capability: 'mail',
  kind: 'mailgun',
  label: 'Mailgun',
  configSchema: configSchema as z.ZodType<MailgunConfig>,
  secretKeys: ['apiKey', 'webhookSigningKey'],
  requiredSecrets: ['apiKey'],
  receiveSecret: 'webhookSigningKey',
  presets: [
    {
      id: 'mailgun',
      label: 'Mailgun (US)',
      config: { baseUrl: MAILGUN_API },
      docsUrl: 'https://documentation.mailgun.com',
    },
    { id: 'mailgun-eu', label: 'Mailgun (EU)', config: { baseUrl: MAILGUN_EU_API } },
  ],
  endpoints: (config) =>
    MAILGUN_HOSTS.has(new URL(config.baseUrl).hostname) ? [config.baseUrl, MAILGUN_STORAGE] : [config.baseUrl],
  create: ({ config, secrets, fetch }) => {
    const base = withoutTrailingSlash(config.baseUrl);
    const auth = { Authorization: `Basic ${Buffer.from(`api:${secrets.apiKey ?? ''}`).toString('base64')}` };
    const allowed = mailgunAdapter.endpoints(config);
    const call = (label: string) => ({
      label,
      secrets: [secrets.apiKey, secrets.webhookSigningKey, auth.Authorization.slice(6)],
      timeoutMs: TIMEOUT_MS,
    });

    /** A stored message of this domain on a Mailgun address; anything else is refused before any request. */
    function storedMessage(raw: string): { url: string; key: string } | null {
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        return null;
      }
      if (url.protocol !== 'https:' && !isPinned([config.baseUrl], url.href)) return null;
      if (!isPinned(allowed, url.href) || url.search || url.hash || url.username) return null;
      const match = /^\/v3\/domains\/([^/]+)\/messages\/([A-Za-z0-9_=-]{1,300})$/.exec(url.pathname);
      if (!match || decodeURIComponent(match[1]!).toLowerCase() !== config.domain) return null;
      return { url: url.href, key: match[2]! };
    }

    async function attachmentsOf(raw: unknown): Promise<InboundAttachment[]> {
      const budget = new AttachmentBudget();
      const out: InboundAttachment[] = [];
      for (const entry of (Array.isArray(raw) ? raw : []) as Record<string, unknown>[]) {
        const size = typeof entry.size === 'number' && entry.size >= 0 ? entry.size : 0;
        const attachment: InboundAttachment = {
          filename: fileNameOf(entry.name ?? entry.filename),
          contentType: contentTypeOf(entry['content-type'] ?? entry.contentType),
          size,
          content: null,
          inline: false,
        };
        const skipped = budget.before(size);
        const url = typeof entry.url === 'string' ? entry.url : '';
        if (skipped || !url || !isPinned(allowed, url)) {
          out.push({ ...attachment, skipped: skipped ?? 'unavailable' });
          continue;
        }
        const response = await send(fetch, url, { method: 'GET', headers: auth }, call('Mailgun attachment'));
        const bytes = await readCapped(response, budget.cap());
        if (!bytes) {
          out.push({ ...attachment, skipped: 'too_large' });
          continue;
        }
        budget.take(bytes.byteLength);
        out.push({ ...attachment, size: bytes.byteLength, content: bytes });
      }
      return out;
    }

    const receive: MailReceiver = {
      maxNoticeBytes: MAX_NOTICE_BYTES,
      async verify({ headers, body, now }) {
        const fields = await noticeFields(headers, body);
        verifyMailgun({
          signingKey: secrets.webhookSigningKey ?? '',
          timestamp: fields.timestamp ?? '',
          token: fields.token ?? '',
          signature: fields.signature ?? '',
          now: now ?? Math.floor(Date.now() / 1000),
        });
        // A signed notice of another kind (an event webhook pointed here) names no stored message.
        const location = fields['message-url'];
        if (!location) return null;
        const stored = storedMessage(location);
        if (!stored) throw new MailSignatureError('The notice names no stored message of this domain.');
        return { ref: stored.url, nonce: fields.token!, nonceTtlSeconds: NONCE_TTL_SECONDS };
      },
      async fetch(notice) {
        const stored = storedMessage(notice.ref);
        if (!stored) throw new ProviderRequestError('Not a stored message of this Mailgun domain.');
        const message = await getJson<StoredMessage>(fetch, stored.url, auth, call('Mailgun stored message'));
        const pairs = headerPairs(message['message-headers']);
        const first = (name: string) => headerValues(pairs, name)[0] ?? null;
        const from =
          parseAddress(first('From')) ?? parseAddress(typeof message.from === 'string' ? message.from : null);
        if (!from) throw new ProviderRequestError('Mailgun returned a mail without a sender.');
        const rawHtml = typeof message['body-html'] === 'string' ? message['body-html'] : null;
        const html = rawHtml && Buffer.byteLength(rawHtml) <= MAIL_LIMITS.htmlBytes ? rawHtml : null;
        const plain = typeof message['body-plain'] === 'string' ? message['body-plain'] : '';
        const date = first('Date');
        const mail: InboundMail = {
          providerMessageId: stored.key,
          messageId: messageIdOf(first('Message-Id')),
          inReplyTo: messageIdOf(first('In-Reply-To')),
          references: referencesOf(headerValues(pairs, 'References')),
          from,
          replyTo: parseAddressList(headerValues(pairs, 'Reply-To')),
          to: parseAddressList(headerValues(pairs, 'To')),
          cc: parseAddressList(headerValues(pairs, 'Cc')),
          recipients: parseAddressList(typeof message.recipients === 'string' ? message.recipients : '').map(
            (entry) => entry.address,
          ),
          envelopeFrom:
            parseAddress(typeof message.sender === 'string' ? message.sender : null)?.address ??
            parseAddress(first('X-Envelope-From'))?.address ??
            parseAddress(first('Return-Path'))?.address ??
            null,
          subject: cut(
            oneLine(first('Subject') ?? (typeof message.subject === 'string' ? message.subject : '')),
            MAIL_LIMITS.subjectChars,
          ),
          text: cut(plain.trim() ? plain : rawHtml ? htmlToText(rawHtml) : '', MAIL_LIMITS.textChars),
          html,
          attachments: await attachmentsOf(message.attachments),
          auth: {
            spf: singleVerdict(pairs, 'X-Mailgun-Spf'),
            dkim: singleVerdict(pairs, 'X-Mailgun-Dkim-Check-Result'),
            dmarc: 'unknown',
          },
          dkimDomains: dkimDomainsOf(headerValues(pairs, 'DKIM-Signature')),
          receivedAt: date && !Number.isNaN(Date.parse(date)) ? new Date(date).toISOString() : new Date().toISOString(),
        };
        return mail;
      },
    };

    const client: MailClient = {
      async send(mail) {
        const sender = mail.from ?? {
          address: config.fromAddress,
          ...(config.fromName ? { name: config.fromName } : {}),
        };
        const form = new URLSearchParams();
        form.set('from', formatAddress(sender));
        for (const entry of mail.to) form.append('to', formatAddress(entry));
        for (const entry of mail.cc ?? []) form.append('cc', formatAddress(entry));
        form.set('subject', oneLine(mail.subject));
        form.set('text', mail.text);
        if (mail.html) form.set('html', mail.html);
        if (mail.replyTo) form.set('h:Reply-To', formatAddress(mail.replyTo));
        if (mail.inReplyTo) form.set('h:In-Reply-To', mail.inReplyTo);
        if (mail.references?.length) form.set('h:References', mail.references.join(' '));
        let response: Response;
        try {
          response = await send(
            fetch,
            `${base}/v3/${encodeURIComponent(config.domain)}/messages`,
            {
              method: 'POST',
              headers: { ...auth, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
              body: form.toString(),
            },
            call('Mailgun send'),
          );
        } catch (error) {
          // 400: Mailgun refuses the message itself (an address it cannot use); no retry helps.
          if (error instanceof ProviderRequestError && error.statusCode === 400) {
            throw new UndeliverableError(error.message);
          }
          throw error;
        }
        const answer = (await response.json().catch(() => ({}))) as { id?: unknown };
        const id = typeof answer.id === 'string' ? answer.id : null;
        return { providerId: id, messageId: messageIdOf(id) };
      },
      async verify() {
        await getJson(fetch, `${base}/v3/domains/${encodeURIComponent(config.domain)}`, auth, call('Mailgun'));
      },
      ...(secrets.webhookSigningKey ? { receive } : {}),
    };
    return client;
  },
  test: (client) => client.verify(),
};
