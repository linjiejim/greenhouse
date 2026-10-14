/**
 * Mail test support: Resend as the fetch the providers layer is given (its sending, Receiving and
 * attachments APIs and its CDN), Svix-signed notices for the inbound route, and an app with the
 * mail capability set up from env (RESEND_*, MAIL_FROM, MAIL_AGENT_DOMAIN).
 */

import { createHmac, randomUUID } from 'node:crypto';
import type { ServiceOptions } from '../../../app.js';
import { createTestApp } from '../../../testing.js';

export const WEBHOOK_SECRET = `whsec_${Buffer.from('greenhouse-test-webhook-secret!!').toString('base64')}`;
export const RESEND_KEY = 're_test_0123456789abcdef';
export const AGENT_DOMAIN = 'agents.acme.test';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export interface FakeMail {
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  /** The receiving server's verdicts (default: all pass). */
  auth?: { spf?: string; dkim?: string; dmarc?: string } | null;
  /** Lower-case header names, as Resend gives them. */
  headers?: Record<string, string | string[]>;
  messageId?: string;
  attachments?: { filename: string; contentType: string; content: string; inline?: boolean; contentId?: string }[];
}

/** Resend for tests: what it received, what it was asked to send, and signed notices. */
export function fakeResend() {
  const state = {
    received: new Map<string, FakeMail>(),
    sent: [] as Record<string, unknown>[],
    /** Requests that reached the fake, as `METHOD path`. */
    requests: [] as string[],
    /** The next sends fail with this answer. */
    sendFailure: null as { status: number; body: unknown } | null,
  };
  let sent = 0;

  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    state.requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (url.origin === 'https://api.resend.com') {
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${RESEND_KEY}`) {
        return json({ name: 'validation_error', message: 'API key is invalid' }, 401);
      }
      if (url.pathname === '/emails' && init?.method === 'POST') {
        if (state.sendFailure) return json(state.sendFailure.body, state.sendFailure.status);
        state.sent.push({
          ...(JSON.parse(String(init.body)) as Record<string, unknown>),
          idempotency_key: new Headers(init.headers).get('idempotency-key'),
        });
        return json({ id: `sent-${++sent}` });
      }
      if (url.pathname === '/domains') return json({ data: [] });
      const match = /^\/emails\/receiving\/([^/]+)(\/attachments)?$/.exec(url.pathname);
      const mail = match ? state.received.get(decodeURIComponent(match[1]!)) : undefined;
      if (match && mail) {
        const id = decodeURIComponent(match[1]!);
        if (match[2]) {
          return json({
            object: 'list',
            has_more: false,
            data: (mail.attachments ?? []).map((part, index) => ({
              id: `att-${index}`,
              filename: part.filename,
              content_type: part.contentType,
              content_disposition: part.inline ? 'inline' : 'attachment',
              content_id: part.contentId ?? null,
              size: Buffer.byteLength(part.content),
              download_url: `https://inbound-cdn.resend.com/${id}/att-${index}?sig=test`,
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            })),
          });
        }
        return json({
          object: 'email',
          id,
          from: mail.from,
          to: mail.to,
          cc: mail.cc ?? [],
          bcc: [],
          reply_to: [],
          received_for: mail.to,
          subject: mail.subject,
          text: mail.text ?? null,
          html: mail.html ?? null,
          message_id: mail.messageId ?? `<${id}@mail.sender.test>`,
          created_at: new Date().toISOString(),
          headers: mail.headers ?? {},
          authentication:
            mail.auth === null ? null : { spf: 'pass', dkim: 'pass', dmarc: 'pass', ...(mail.auth ?? {}) },
          attachments: [],
        });
      }
      return json({ message: 'Not found' }, 404);
    }
    if (url.origin === 'https://inbound-cdn.resend.com') {
      const [, id, part] = url.pathname.split('/');
      const index = Number(part?.replace('att-', ''));
      const content = state.received.get(id ?? '')?.attachments?.[index]?.content;
      return content === undefined ? new Response('gone', { status: 404 }) : new Response(content);
    }
    throw new Error(`The test network has no ${url.href}`);
  }) as typeof globalThis.fetch;

  /** Resend received this mail; returns its id. */
  const receive = (mail: FakeMail): string => {
    const id = randomUUID();
    state.received.set(id, mail);
    return id;
  };

  /** A Svix-signed `email.received` notice for a mail Resend holds. */
  const notice = (
    emailId: string,
    options: { svixId?: string; timestamp?: number; secret?: string; type?: string } = {},
  ): { headers: Record<string, string>; body: string } => {
    const svixId = options.svixId ?? `msg_${randomUUID().replace(/-/g, '')}`;
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const body = JSON.stringify({
      type: options.type ?? 'email.received',
      created_at: new Date().toISOString(),
      data: { email_id: emailId, subject: 'what the notice says is never read' },
    });
    const secret = options.secret ?? WEBHOOK_SECRET;
    const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
    const signature = createHmac('sha256', key).update(`${svixId}.${timestamp}.${body}`).digest('base64');
    return {
      headers: {
        'content-type': 'application/json',
        'svix-id': svixId,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${signature}`,
      },
      body,
    };
  };

  return { fetch, state, receive, notice };
}

/** An app whose mail capability is Resend (receiving included) and whose Agents have addresses. */
export async function mailApp(options: { env?: Record<string, string>; services?: ServiceOptions } = {}) {
  const resend = fakeResend();
  const app = createTestApp(
    {
      RESEND_API_KEY: RESEND_KEY,
      RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
      MAIL_FROM: 'Greenhouse <gh@acme.test>',
      MAIL_AGENT_DOMAIN: AGENT_DOMAIN,
      ...options.env,
    },
    { fetch: resend.fetch, ...options.services },
  );
  const admin = await app.member('admin', 'boss@acme.test');
  const lin = await app.member('member', 'lin@acme.test');
  /** POSTs a notice to the public inbound route, as the vendor does. */
  const post = async (notice: { headers: Record<string, string>; body: string }, instance = 'env-mail-resend') => {
    const response = await app.app.request(`/api/mail/inbound/${instance}`, {
      method: 'POST',
      headers: notice.headers,
      body: notice.body,
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as any) : null };
  };
  /** Delivers one mail through the route: Resend received it and notified us. */
  const deliver = async (mail: FakeMail) => {
    const id = resend.receive(mail);
    return { emailId: id, ...(await post(resend.notice(id))) };
  };
  const mailbox = async (token: string, agent = 'main') =>
    (await app.call('GET', `/api/agents/${agent}/mailbox`, { token })).body;
  return { ...app, resend, admin, lin, post, deliver, mailbox };
}
