/**
 * Resend as the `mail` capability: sends through its HTTP API and receives through Resend
 * Receiving (providers.md §6 邮箱).
 *
 * - Sending: POST /emails with the key; threading headers go in `headers`.
 * - Receiving: Resend posts an `email.received` event signed by Svix (`svix-id`, `svix-timestamp`,
 *   `svix-signature`: HMAC-SHA256 over `id.timestamp.body` with the base64 secret after `whsec_`).
 *   The event is only a signal: the mail, its headers, the receiving server's SPF / DKIM / DMARC
 *   verdicts and its attachments are fetched from the Receiving API with the key. A forged event
 *   can name only a mail Resend really holds for this account.
 * - The key goes only to the base URL. Attachments download from Resend's CDN through signed
 *   links that carry no key.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { getJson, ProviderRequestError, providerError, send, withoutTrailingSlash } from '../http.js';
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
  htmlToText,
  MAIL_LIMITS,
  messageIdOf,
  oneLine,
  parseAddress,
  parseAddressList,
  readCapped,
  referencesOf,
  verdictOf,
} from './shared.js';

export const RESEND_API = 'https://api.resend.com';
/** Where Resend serves received attachments, through signed links. */
export const RESEND_CDN = 'https://inbound-cdn.resend.com';

const configSchema = z.object({
  baseUrl: z.string().url().default(RESEND_API),
  /** The sender of system mail (invites, resets, notifications); its domain is verified at Resend. */
  fromAddress: z.string().trim().email(),
  fromName: z.string().trim().min(1).max(100).optional(),
});
export type ResendConfig = z.infer<typeof configSchema>;

const TIMEOUT_MS = 20_000;
/** Svix signs with the time it sent; an older or future notice is refused. */
const TOLERANCE_SECONDS = 5 * 60;
/** Svix retries a notice for about a day with the same id. */
const NONCE_TTL_SECONDS = 2 * 24 * 60 * 60;
/** An event is metadata only; the mail itself is never in it. */
const MAX_NOTICE_BYTES = 256 * 1024;
const MAIL_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * Checks a Svix signature (Resend's webhooks): one of the space-separated `v1,<base64>` values must
 * be the HMAC of `id.timestamp.body`. Returns the notice's id, which Svix keeps across retries.
 */
export function verifySvix(input: { secret: string; headers: Headers; body: Uint8Array; now: number }): string {
  const id = input.headers.get('svix-id') ?? input.headers.get('webhook-id');
  const timestamp = input.headers.get('svix-timestamp') ?? input.headers.get('webhook-timestamp');
  const signatures = input.headers.get('svix-signature') ?? input.headers.get('webhook-signature');
  if (!id || !timestamp || !signatures) throw new MailSignatureError('The notice is not signed.');
  if (!/^\d{1,12}$/.test(timestamp)) throw new MailSignatureError('The notice has no valid time.');
  if (Math.abs(input.now - Number(timestamp)) > TOLERANCE_SECONDS) {
    throw new MailSignatureError('The notice is too old or from the future.');
  }
  const key = Buffer.from(input.secret.startsWith('whsec_') ? input.secret.slice(6) : input.secret, 'base64');
  if (!key.length) throw new MailSignatureError('The webhook secret is not usable.');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(input.body).digest();
  const matches = signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',', 2);
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!matches) throw new MailSignatureError('The signature does not match.');
  return id;
}

interface ReceivedEmail {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  cc?: unknown;
  reply_to?: unknown;
  received_for?: unknown;
  subject?: unknown;
  html?: unknown;
  text?: unknown;
  message_id?: unknown;
  created_at?: unknown;
  headers?: Record<string, unknown> | null;
  authentication?: { spf?: unknown; dkim?: unknown; dmarc?: unknown } | null;
}

interface ReceivedAttachment {
  id?: unknown;
  filename?: unknown;
  content_type?: unknown;
  content_disposition?: unknown;
  content_id?: unknown;
  size?: unknown;
  download_url?: unknown;
}

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : typeof value === 'string'
      ? [value]
      : [];

/** A header from Resend's `headers` object: its keys are lower case, a repeated one an array. */
const header = (headers: ReceivedEmail['headers'], name: string): string[] => strings(headers?.[name]);

export const resendAdapter: ProviderAdapter<'mail', ResendConfig> = {
  capability: 'mail',
  kind: 'resend',
  label: 'Resend',
  configSchema: configSchema as z.ZodType<ResendConfig>,
  secretKeys: ['apiKey', 'webhookSecret'],
  requiredSecrets: ['apiKey'],
  receiveSecret: 'webhookSecret',
  presets: [{ id: 'resend', label: 'Resend', config: { baseUrl: RESEND_API }, docsUrl: 'https://resend.com/docs' }],
  endpoints: (config) => [config.baseUrl, RESEND_CDN],
  create: ({ config, secrets, fetch }) => {
    const base = withoutTrailingSlash(config.baseUrl);
    const auth = { Authorization: `Bearer ${secrets.apiKey ?? ''}` };
    const call = (label: string) => ({
      label,
      secrets: [secrets.apiKey, secrets.webhookSecret],
      timeoutMs: TIMEOUT_MS,
    });

    async function attachmentsOf(id: string): Promise<InboundAttachment[]> {
      const listed = await getJson<{ data?: ReceivedAttachment[] }>(
        fetch,
        `${base}/emails/receiving/${encodeURIComponent(id)}/attachments`,
        auth,
        call('Resend received attachments'),
      );
      const budget = new AttachmentBudget();
      const out: InboundAttachment[] = [];
      for (const entry of listed.data ?? []) {
        const size = typeof entry.size === 'number' && entry.size >= 0 ? entry.size : 0;
        const attachment: InboundAttachment = {
          filename: fileNameOf(entry.filename),
          contentType: contentTypeOf(entry.content_type),
          size,
          content: null,
          inline: entry.content_disposition === 'inline',
          ...(typeof entry.content_id === 'string' && entry.content_id
            ? { contentId: oneLine(entry.content_id).replace(/^<|>$/g, '') }
            : {}),
        };
        const skipped = budget.before(size);
        if (skipped || typeof entry.download_url !== 'string') {
          out.push({ ...attachment, skipped: skipped ?? 'unavailable' });
          continue;
        }
        // A signed link: no key goes with it, and only Resend's CDN (or the base URL) is reached.
        if (!isPinned(resendAdapter.endpoints(config), entry.download_url)) {
          out.push({ ...attachment, skipped: 'unavailable' });
          continue;
        }
        const response = await send(fetch, entry.download_url, { method: 'GET' }, call('Resend attachment'));
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
        const nonce = verifySvix({
          secret: secrets.webhookSecret ?? '',
          headers,
          body,
          now: now ?? Math.floor(Date.now() / 1000),
        });
        let event: { type?: unknown; data?: { email_id?: unknown } };
        try {
          event = JSON.parse(Buffer.from(body).toString('utf8'));
        } catch {
          throw new MailSignatureError('The notice is not JSON.');
        }
        if (event.type !== 'email.received') return null;
        const ref = event.data?.email_id;
        if (typeof ref !== 'string' || !MAIL_ID.test(ref)) throw new MailSignatureError('The notice names no mail.');
        return { ref, nonce, nonceTtlSeconds: NONCE_TTL_SECONDS };
      },
      async fetch(notice) {
        const email = await getJson<ReceivedEmail>(
          fetch,
          `${base}/emails/receiving/${encodeURIComponent(notice.ref)}?html_format=cid`,
          auth,
          call('Resend received email'),
        );
        const id = typeof email.id === 'string' && email.id ? email.id : notice.ref;
        const html =
          typeof email.html === 'string' && Buffer.byteLength(email.html) <= MAIL_LIMITS.htmlBytes ? email.html : null;
        const text = typeof email.text === 'string' && email.text.trim() ? email.text : html ? htmlToText(html) : '';
        const from = parseAddress(typeof email.from === 'string' ? email.from : null);
        if (!from) throw new ProviderRequestError('Resend returned a mail without a sender.');
        const mail: InboundMail = {
          providerMessageId: id,
          messageId: messageIdOf(
            typeof email.message_id === 'string' ? email.message_id : header(email.headers, 'message-id')[0],
          ),
          inReplyTo: messageIdOf(header(email.headers, 'in-reply-to')[0]),
          references: referencesOf(header(email.headers, 'references')),
          from,
          replyTo: parseAddressList(strings(email.reply_to)),
          to: parseAddressList(strings(email.to)),
          cc: parseAddressList(strings(email.cc)),
          recipients: parseAddressList(strings(email.received_for)).map((entry) => entry.address),
          envelopeFrom: parseAddress(header(email.headers, 'return-path')[0])?.address ?? null,
          subject: cut(oneLine(typeof email.subject === 'string' ? email.subject : ''), MAIL_LIMITS.subjectChars),
          text: cut(text, MAIL_LIMITS.textChars),
          html,
          attachments: await attachmentsOf(id),
          auth: {
            spf: verdictOf(email.authentication?.spf),
            dkim: verdictOf(email.authentication?.dkim),
            dmarc: verdictOf(email.authentication?.dmarc),
          },
          dkimDomains: dkimDomainsOf(header(email.headers, 'dkim-signature')),
          receivedAt:
            typeof email.created_at === 'string' && !Number.isNaN(Date.parse(email.created_at))
              ? new Date(email.created_at).toISOString()
              : new Date().toISOString(),
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
        const headers: Record<string, string> = {};
        if (mail.inReplyTo) headers['In-Reply-To'] = mail.inReplyTo;
        if (mail.references?.length) headers.References = mail.references.join(' ');
        const label = call('Resend send');
        let response: Response;
        try {
          response = await send(
            fetch,
            `${base}/emails`,
            {
              method: 'POST',
              headers: {
                ...auth,
                'Content-Type': 'application/json',
                Accept: 'application/json',
                ...(mail.idempotencyKey ? { 'Idempotency-Key': mail.idempotencyKey.slice(0, 256) } : {}),
              },
              body: JSON.stringify({
                from: formatAddress(sender),
                to: mail.to.map(formatAddress),
                ...(mail.cc?.length ? { cc: mail.cc.map(formatAddress) } : {}),
                ...(mail.replyTo ? { reply_to: formatAddress(mail.replyTo) } : {}),
                subject: oneLine(mail.subject),
                text: mail.text,
                ...(mail.html ? { html: mail.html } : {}),
                ...(Object.keys(headers).length ? { headers } : {}),
              }),
            },
            label,
          );
        } catch (error) {
          // Resend refuses a message it can never send (a bad address, an unverified sender) with 422.
          if (error instanceof ProviderRequestError && (error.statusCode === 422 || error.statusCode === 400)) {
            throw new UndeliverableError(error.message);
          }
          throw error;
        }
        const answer = (await response.json().catch(() => ({}))) as { id?: unknown };
        return { providerId: typeof answer.id === 'string' ? answer.id : null, messageId: null };
      },
      async verify() {
        const label = call('Resend');
        try {
          await getJson(fetch, `${base}/domains`, auth, label);
        } catch (error) {
          // A sending-only key cannot list domains; it is enough unless this instance also receives.
          const restricted =
            error instanceof ProviderRequestError && error.statusCode === 401 && /restricted/i.test(error.message);
          if (!restricted) throw error;
          if (secrets.webhookSecret) {
            throw providerError(label, {
              detail: 'This key can only send. Receiving needs a key with full access.',
              statusCode: 401,
            });
          }
        }
      },
      ...(secrets.webhookSecret ? { receive } : {}),
    };
    return client;
  },
  test: (client) => client.verify(),
};
