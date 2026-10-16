/**
 * Recorded requests and answers for the mail adapters: a Svix-signed Resend `email.received`
 * event with its signature, a Mailgun `store(notify=…)` notice with its signature, and the vendors'
 * answers for the mail they name. The signatures were computed once and are written down here, so
 * the tests check the adapters against fixed values rather than against their own arithmetic.
 */

// ─── Resend (Svix) ───────────────────────────────────────

export const RESEND_SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
export const RESEND_EMAIL_ID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c';
export const RESEND_NOTICE_ID = 'msg_31pVxGkN0qXEaRzRq0g1oVHkS3m';
export const RESEND_NOTICE_TIME = 1760433601;
export const RESEND_NOTICE_BODY =
  '{"type":"email.received","created_at":"2026-10-14T09:20:01.000Z","data":{"email_id":"4ef9a417-02e9-4d39-ad75-9611e0fcc33c","created_at":"2026-10-14T09:20:00.512Z","from":"Alice <alice@example.com>","to":["greeny-k3v9@agents.example.com"],"cc":[],"bcc":[],"received_for":["greeny-k3v9@agents.example.com"],"message_id":"<CAF=alice-1@mail.example.com>","subject":"Quarterly numbers","attachments":[{"id":"2a0c9ce0-3112-4728-976e-47ddcd16a318","filename":"q3.csv","content_type":"text/csv","content_disposition":"attachment","content_id":null}]}}';
export const RESEND_NOTICE_SIGNATURE = 'v1,nfgZhqtIu1Hou+lYirBkJ1Yqv+ksjnLVkw6Tge12vPI=';

/** Svix's own published example (docs.svix.com, "Verifying payloads manually"). */
export const SVIX_EXAMPLE = {
  secret: 'whsec_plJ3nmyCDGBKInavdOK15jsl',
  id: 'msg_loFOjxBNrRLzqYUf',
  timestamp: 1731705121,
  body: '{"event_type":"ping","data":{"success":true}}',
  signature: 'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=',
};

/** GET /emails/receiving/:id, as the Receiving API answers it. */
export const RESEND_RECEIVED = {
  object: 'email',
  id: RESEND_EMAIL_ID,
  to: ['greeny-k3v9@agents.example.com'],
  from: 'Alice <alice@example.com>',
  created_at: '2026-10-14T09:20:00.512Z',
  subject: 'Quarterly numbers',
  html: '<p>Hi Greeny,</p><p>The numbers are attached.<img src="https://tracker.example/p.gif"></p>',
  text: null,
  headers: {
    'return-path': 'bounces+alice=example.com@mail.example.com',
    'mime-version': '1.0',
    'in-reply-to': '<greeny-1@agents.example.com>',
    references: '<thread-0@mail.example.com> <greeny-1@agents.example.com>',
    'dkim-signature': 'v=1; a=rsa-sha256; c=relaxed/relaxed; d=example.com; s=s1; h=from:to:subject; bh=abc=; b=def=',
  },
  bcc: [],
  cc: ['Bob Li <BOB@example.com>'],
  reply_to: [],
  received_for: ['greeny-k3v9@agents.example.com'],
  message_id: '<CAF=alice-1@mail.example.com>',
  authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
  raw: { download_url: 'https://inbound-cdn.resend.com/raw/abc?sig=1', expires_at: '2026-10-14T10:20:00.512Z' },
  attachments: [
    {
      id: '2a0c9ce0-3112-4728-976e-47ddcd16a318',
      filename: 'q3.csv',
      content_type: 'text/csv',
      content_disposition: 'attachment',
      content_id: null,
      size: 21,
    },
  ],
};

/** GET /emails/receiving/:id/attachments. */
export const RESEND_ATTACHMENTS = {
  object: 'list',
  has_more: false,
  data: [
    {
      id: '2a0c9ce0-3112-4728-976e-47ddcd16a318',
      filename: 'q3.csv',
      size: 21,
      content_type: 'text/csv',
      content_disposition: 'attachment',
      content_id: null,
      download_url: `https://inbound-cdn.resend.com/${RESEND_EMAIL_ID}/attachments/2a0c9ce0?sig=x1`,
      expires_at: '2026-10-14T10:20:00.512Z',
    },
    {
      id: '9b1d8c7e-0000-4000-8000-000000000002',
      filename: 'video.mp4',
      size: 40 * 1024 * 1024,
      content_type: 'video/mp4',
      content_disposition: 'attachment',
      content_id: null,
      download_url: `https://inbound-cdn.resend.com/${RESEND_EMAIL_ID}/attachments/9b1d8c7e?sig=x2`,
      expires_at: '2026-10-14T10:20:00.512Z',
    },
  ],
};

export const CSV_BYTES = 'quarter,revenue\nQ3,42\n';

// ─── Mailgun ─────────────────────────────────────────────

export const MAILGUN_SIGNING_KEY = 'test-signing-4e8c1f0b7a2d9e6c3b5a8f1d0e7c2b9a';
export const MAILGUN_DOMAIN = 'agents.example.com';
export const MAILGUN_TIMESTAMP = '1760433601';
export const MAILGUN_TOKEN = '8a0c7f9b2e4d6c1a3f5e7d9b0c2a4e6f8b1d3c5e7a9f0b2d4c';
export const MAILGUN_SIGNATURE = '2bf74642ff5c4dfec87a67d745cb1aad50be924d286b03b7993f4b825bd38e8b';
export const MAILGUN_STORAGE_KEY = 'BAABAQYwtTH8CQ3Ze1fQpQbbs0Zp2UMHMQ==';
export const MAILGUN_MESSAGE_URL = `https://storage-us-east4.api.mailgun.net/v3/domains/${MAILGUN_DOMAIN}/messages/${MAILGUN_STORAGE_KEY}`;

/** The notify POST: the signature fields and the stored message's address, with Mailgun's parsed copy (never read). */
export const MAILGUN_NOTICE_FIELDS: Record<string, string> = {
  domain: MAILGUN_DOMAIN,
  recipient: 'greeny-k3v9@agents.example.com',
  sender: 'alice@example.com',
  from: 'Alice <alice@example.com>',
  subject: 'Forged subject that is never read',
  'body-plain': 'Forged body that is never read',
  'message-url': MAILGUN_MESSAGE_URL,
  timestamp: MAILGUN_TIMESTAMP,
  token: MAILGUN_TOKEN,
  signature: MAILGUN_SIGNATURE,
};

/** GET <message-url>, as the Messages API answers a stored message. */
export const MAILGUN_STORED = {
  recipients: 'greeny-k3v9@agents.example.com',
  sender: 'bounces@mail.example.com',
  from: 'Alice <alice@example.com>',
  subject: 'Quarterly numbers',
  'body-plain': 'Hi Greeny,\n\nThe numbers are attached.\n',
  'body-html': '<p>Hi Greeny,</p><p>The numbers are attached.</p>',
  'stripped-text': 'Hi Greeny,\n\nThe numbers are attached.',
  'message-headers': [
    ['Received', 'from mail.example.com (mail.example.com [203.0.113.10]) by mxa.mailgun.org with ESMTP'],
    ['X-Envelope-From', '<bounces@mail.example.com>'],
    ['Dkim-Signature', 'v=1; a=rsa-sha256; d=mail.example.com; s=k1; h=from:to; bh=x=; b=y='],
    ['From', 'Alice <alice@example.com>'],
    ['To', '"Greeny" <greeny-k3v9@agents.example.com>'],
    ['Cc', 'bob@example.com'],
    ['Subject', 'Quarterly numbers'],
    ['Message-Id', '<CAF=alice-1@mail.example.com>'],
    ['In-Reply-To', '<greeny-1@agents.example.com>'],
    ['References', '<greeny-1@agents.example.com>'],
    ['Date', 'Tue, 14 Oct 2026 09:20:00 +0000'],
    ['X-Mailgun-Incoming', 'Yes'],
    ['X-Mailgun-Spf', 'Pass'],
    ['X-Mailgun-Dkim-Check-Result', 'Pass'],
  ],
  attachments: [
    {
      url: `${MAILGUN_MESSAGE_URL}/attachments/0`,
      'content-type': 'text/csv',
      name: 'q3.csv',
      size: 21,
    },
    {
      url: 'https://evil.example/steal',
      'content-type': 'text/plain',
      name: 'elsewhere.txt',
      size: 3,
    },
  ],
};
