/**
 * Mail for the browser tests, served by the fake model's server (fake-llm.mjs):
 *   /resend/…          Resend: sending (POST /emails), the Receiving API (GET /emails/receiving/:id
 *                      and its attachments, downloaded from /resend/cdn/…) and GET /domains, all
 *                      with the key RESEND_KEY. An admin points a Resend instance's base URL here.
 *   POST /resend/_inbound   test door: Resend "received" this mail; answers its id
 *   GET  /resend/_sent      test door: what was sent, newest last
 *   GET  /mailbox/_ports    a member's own mailbox (fake-mailbox.mjs) on free ports: { imap, smtp }
 * The tests sign the `email.received` notice themselves and post it to the API.
 */

import { startFakeMailbox } from './fake-mailbox.mjs';

export const RESEND_KEY = 're_e2e_0123456789';
/** The mailbox a member connects in 设置 → 连接. */
export const MAILBOX = { user: 'mei@example.com', password: 'mailbox-password' };

const received = new Map();
const sent = [];
let counter = 0;
let mailbox = null;

function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

function ensureMailbox() {
  mailbox ??= startFakeMailbox({
    ...MAILBOX,
    messages: [
      {
        from: 'Billing <billing@vendor.example>',
        to: MAILBOX.user,
        subject: 'Invoice 42',
        text: 'Please pay invoice 42 by Friday.',
        messageId: '<invoice-42@vendor.example>',
      },
    ],
  });
  return mailbox;
}

function receiving(id, mail) {
  return {
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
    message_id: mail.message_id ?? `<${id}@sender.example>`,
    created_at: new Date().toISOString(),
    headers: mail.headers ?? {},
    authentication: mail.authentication ?? { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
    attachments: [],
  };
}

/** Answers a request for mail; false when the path is not one of these. */
export function handleMail(request, response, raw, origin) {
  const url = new URL(request.url ?? '/', origin);
  if (url.pathname === '/mailbox/_ports') {
    void ensureMailbox().then((box) => json(response, 200, { imap: box.imapPort, smtp: box.smtpPort }));
    return true;
  }
  if (!url.pathname.startsWith('/resend/')) return false;
  const path = url.pathname.slice('/resend'.length);
  const method = request.method ?? 'GET';

  if (path === '/_inbound' && method === 'POST') {
    const id = `e2e-mail-${Date.now().toString(36)}-${(counter += 1)}`;
    received.set(id, JSON.parse(raw || '{}'));
    json(response, 201, { id });
    return true;
  }
  if (path === '/_sent' && method === 'GET') {
    json(response, 200, sent);
    return true;
  }
  const cdn = /^\/cdn\/([^/]+)\/(\d+)$/.exec(path);
  if (cdn) {
    const part = received.get(cdn[1])?.attachments?.[Number(cdn[2])];
    if (!part) json(response, 404, { message: 'gone' });
    else {
      response.writeHead(200, { 'content-type': part.content_type });
      response.end(part.content);
    }
    return true;
  }

  if (request.headers.authorization !== `Bearer ${RESEND_KEY}`) {
    json(response, 401, { name: 'validation_error', message: 'API key is invalid' });
    return true;
  }
  if (path === '/emails' && method === 'POST') {
    const body = JSON.parse(raw || '{}');
    sent.push({ ...body, idempotency_key: request.headers['idempotency-key'] ?? null });
    json(response, 200, { id: `e2e-sent-${sent.length}` });
    return true;
  }
  if (path === '/domains') {
    json(response, 200, { data: [] });
    return true;
  }
  const match = /^\/emails\/receiving\/([^/]+)(\/attachments)?$/.exec(path);
  const mail = match && received.get(match[1]);
  if (match && mail) {
    if (match[2]) {
      json(response, 200, {
        object: 'list',
        has_more: false,
        data: (mail.attachments ?? []).map((part, index) => ({
          id: `att-${index}`,
          filename: part.filename,
          content_type: part.content_type,
          content_disposition: 'attachment',
          content_id: null,
          size: Buffer.byteLength(part.content),
          download_url: `${origin}/resend/cdn/${match[1]}/${index}`,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        })),
      });
    } else json(response, 200, receiving(match[1], mail));
    return true;
  }
  json(response, 404, { message: 'Not found' });
  return true;
}
