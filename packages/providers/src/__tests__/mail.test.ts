import { describe, expect, it } from 'vitest';
import { mailgunAdapter, verifyMailgun } from '../mail/mailgun.js';
import { resendAdapter, verifySvix } from '../mail/resend.js';
import {
  formatAddress,
  htmlToText,
  MAIL_LIMITS,
  messageIdOf,
  parseAddress,
  parseAddressList,
  readCapped,
  referencesOf,
  singleVerdict,
} from '../mail/shared.js';
import { EndpointViolation } from '../pinned-fetch.js';
import { MailSignatureError, UndeliverableError } from '../types.js';
import { connect, json, rejection, sent } from './fake-network.js';
import {
  CSV_BYTES,
  MAILGUN_DOMAIN,
  MAILGUN_MESSAGE_URL,
  MAILGUN_NOTICE_FIELDS,
  MAILGUN_SIGNATURE,
  MAILGUN_SIGNING_KEY,
  MAILGUN_STORAGE_KEY,
  MAILGUN_STORED,
  MAILGUN_TIMESTAMP,
  MAILGUN_TOKEN,
  RESEND_ATTACHMENTS,
  RESEND_EMAIL_ID,
  RESEND_NOTICE_BODY,
  RESEND_NOTICE_ID,
  RESEND_NOTICE_SIGNATURE,
  RESEND_NOTICE_TIME,
  RESEND_RECEIVED,
  RESEND_SECRET,
  SVIX_EXAMPLE,
} from './mail-fixtures.js';

const bytes = (text: string) => new TextEncoder().encode(text);

const svixHeaders = (overrides: Record<string, string> = {}) =>
  new Headers({
    'content-type': 'application/json',
    'svix-id': RESEND_NOTICE_ID,
    'svix-timestamp': String(RESEND_NOTICE_TIME),
    'svix-signature': RESEND_NOTICE_SIGNATURE,
    ...overrides,
  });

describe('mail addresses and headers', () => {
  it('reads addresses as headers write them', () => {
    expect(parseAddress('Alice <ALICE@Example.com>')).toEqual({ address: 'alice@example.com', name: 'Alice' });
    expect(parseAddress('"Li, Bob" <bob@example.com>')).toEqual({ address: 'bob@example.com', name: 'Li, Bob' });
    expect(parseAddress('carol@example.com')).toEqual({ address: 'carol@example.com' });
    expect(parseAddress('not an address')).toBeNull();
    expect(parseAddress('x'.repeat(2000))).toBeNull();
    expect(
      parseAddressList(['"Li, Bob" <bob@example.com>, carol@example.com', 'BOB@example.com']).map((a) => a.address),
    ).toEqual(['bob@example.com', 'carol@example.com']);
    expect(formatAddress({ address: 'a@b.co', name: 'Greeny 绿' })).toBe('Greeny 绿 <a@b.co>');
    expect(formatAddress({ address: 'a@b.co', name: 'Li, "Bob"\r\nBcc: x@y.z' })).toBe(
      '"Li, \\"Bob\\" Bcc: x@y.z" <a@b.co>',
    );
  });

  it('keeps Message-IDs and references in angle brackets', () => {
    expect(messageIdOf(' <a.b@c> ')).toBe('<a.b@c>');
    expect(messageIdOf('a.b@c')).toBe('<a.b@c>');
    expect(messageIdOf('no id here')).toBeNull();
    expect(referencesOf('<a@x> junk <b@y>\r\n <c@z>')).toEqual(['<a@x>', '<b@y>', '<c@z>']);
  });

  it('trusts a verdict header only when it appears once', () => {
    const pairs: [string, string][] = [['X-Mailgun-Spf', 'Pass']];
    expect(singleVerdict(pairs, 'x-mailgun-spf')).toBe('pass');
    expect(singleVerdict([...pairs, ['X-Mailgun-Spf', 'Pass']], 'X-Mailgun-Spf')).toBe('unknown');
    expect(singleVerdict([], 'X-Mailgun-Spf')).toBe('unknown');
  });

  it('turns HTML into text in one pass, whatever the markup', () => {
    expect(
      htmlToText('<style>p{}</style><p>Hi&nbsp;there</p><p>Second &amp; last<br>line</p><script>x()</script>'),
    ).toBe('Hi there\n\nSecond & last\nline');
    const started = Date.now();
    htmlToText('<'.repeat(200_000) + 'a'.repeat(200_000));
    htmlToText('<script'.repeat(100_000));
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('stops reading a body past its cap', async () => {
    expect(await readCapped(new Response('x'.repeat(10)), 5)).toBeNull();
    expect(await readCapped(new Response('x'.repeat(10), { headers: { 'content-length': '10' } }), 5)).toBeNull();
    expect(new TextDecoder().decode((await readCapped(new Response('hello'), 5))!)).toBe('hello');
  });
});

describe('Svix signatures (Resend)', () => {
  it("verifies Svix's own published example", () => {
    const headers = new Headers({
      'svix-id': SVIX_EXAMPLE.id,
      'svix-timestamp': String(SVIX_EXAMPLE.timestamp),
      'svix-signature': `v1,AAAA ${SVIX_EXAMPLE.signature}`,
    });
    expect(
      verifySvix({ secret: SVIX_EXAMPLE.secret, headers, body: bytes(SVIX_EXAMPLE.body), now: SVIX_EXAMPLE.timestamp }),
    ).toBe(SVIX_EXAMPLE.id);
  });

  it('refuses a changed body, another secret, an old notice and a missing signature', () => {
    const check = (headers: Headers, body = RESEND_NOTICE_BODY, now = RESEND_NOTICE_TIME, secret = RESEND_SECRET) => {
      try {
        verifySvix({ secret, headers, body: bytes(body), now });
        return 'ok';
      } catch (error) {
        expect(error).toBeInstanceOf(MailSignatureError);
        return (error as Error).message;
      }
    };
    expect(check(svixHeaders())).toBe('ok');
    expect(check(svixHeaders(), RESEND_NOTICE_BODY.replace('Quarterly', 'Quarterlz'))).toMatch(/does not match/);
    expect(check(svixHeaders(), RESEND_NOTICE_BODY, RESEND_NOTICE_TIME, SVIX_EXAMPLE.secret)).toMatch(/does not match/);
    expect(check(svixHeaders(), RESEND_NOTICE_BODY, RESEND_NOTICE_TIME + 301)).toMatch(/too old/);
    expect(check(svixHeaders({ 'svix-signature': '' }))).toMatch(/not signed/);
    expect(check(svixHeaders({ 'svix-signature': 'v2,nfgZhqtIu1Hou+lYirBkJ1Yqv+ksjnLVkw6Tge12vPI=' }))).toMatch(
      /does not match/,
    );
  });
});

/** Resend's API and CDN as the recorded answers, everything else a 404. */
function resendNetwork(overrides: { downloads?: Record<string, string> } = {}) {
  return (url: string, init: RequestInit) => {
    const { pathname, origin } = new URL(url);
    if (origin === 'https://api.resend.com' && pathname === `/emails/receiving/${RESEND_EMAIL_ID}`) {
      return json(RESEND_RECEIVED);
    }
    if (origin === 'https://api.resend.com' && pathname === `/emails/receiving/${RESEND_EMAIL_ID}/attachments`) {
      return json(RESEND_ATTACHMENTS);
    }
    if (origin === 'https://inbound-cdn.resend.com') {
      return new Response(overrides.downloads?.[pathname] ?? CSV_BYTES, { headers: { 'content-type': 'text/csv' } });
    }
    if (origin === 'https://api.resend.com' && pathname === '/emails' && init.method === 'POST') {
      return json({ id: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794' });
    }
    return json({ message: 'Not found' }, 404);
  };
}

const resendConfig = { fromAddress: 'greenhouse@example.com', fromName: 'Greenhouse' };
const resendSecrets = { apiKey: 're_test_key_1234567890', webhookSecret: RESEND_SECRET };

describe('the Resend adapter', () => {
  it('takes a signed email.received notice only as a signal, then fetches the mail with the key', async () => {
    const { client, fake } = connect(resendAdapter, resendConfig, resendNetwork(), resendSecrets);
    const notice = await client.receive!.verify({
      headers: svixHeaders(),
      body: bytes(RESEND_NOTICE_BODY),
      now: RESEND_NOTICE_TIME,
    });
    expect(notice).toEqual({ ref: RESEND_EMAIL_ID, nonce: RESEND_NOTICE_ID, nonceTtlSeconds: expect.any(Number) });
    expect(fake).not.toHaveBeenCalled();

    const mail = await client.receive!.fetch(notice!);
    expect(mail).toMatchObject({
      providerMessageId: RESEND_EMAIL_ID,
      messageId: '<CAF=alice-1@mail.example.com>',
      inReplyTo: '<greeny-1@agents.example.com>',
      references: ['<thread-0@mail.example.com>', '<greeny-1@agents.example.com>'],
      from: { address: 'alice@example.com', name: 'Alice' },
      to: [{ address: 'greeny-k3v9@agents.example.com' }],
      cc: [{ address: 'bob@example.com', name: 'Bob Li' }],
      recipients: ['greeny-k3v9@agents.example.com'],
      envelopeFrom: 'bounces+alice=example.com@mail.example.com',
      subject: 'Quarterly numbers',
      text: 'Hi Greeny,\n\nThe numbers are attached.',
      auth: { spf: 'pass', dkim: 'pass', dmarc: 'pass' },
      dkimDomains: ['example.com'],
      receivedAt: '2026-10-14T09:20:00.512Z',
    });
    expect(mail.html).toContain('tracker.example');
    expect(mail.attachments).toHaveLength(2);
    expect(new TextDecoder().decode(mail.attachments[0]!.content!)).toBe(CSV_BYTES);
    expect(mail.attachments[1]).toMatchObject({ filename: 'video.mp4', content: null, skipped: 'too_large' });

    // The key went to the API, never to the CDN's signed links.
    const calls = fake.mock.calls.map((_, index) => sent(fake, index));
    expect(calls.map((call) => call.url.origin)).toEqual([
      'https://api.resend.com',
      'https://api.resend.com',
      'https://inbound-cdn.resend.com',
    ]);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer re_test_key_1234567890');
    expect(calls[2]!.headers.get('authorization')).toBeNull();
  });

  it('ignores other events and refuses a notice without an email id', async () => {
    const { client } = connect(resendAdapter, resendConfig, resendNetwork(), {
      ...resendSecrets,
      webhookSecret: SVIX_EXAMPLE.secret,
    });
    const ping = await client.receive!.verify({
      headers: new Headers({
        'svix-id': SVIX_EXAMPLE.id,
        'svix-timestamp': String(SVIX_EXAMPLE.timestamp),
        'svix-signature': SVIX_EXAMPLE.signature,
      }),
      body: bytes(SVIX_EXAMPLE.body),
      now: SVIX_EXAMPLE.timestamp,
    });
    expect(ping).toBeNull();
  });

  it('never fetches a download link outside Resend', async () => {
    const elsewhere = {
      ...RESEND_ATTACHMENTS,
      data: [{ ...RESEND_ATTACHMENTS.data[0]!, download_url: 'https://evil.example/collect' }],
    };
    const { client, fake } = connect(
      resendAdapter,
      resendConfig,
      (url) => (url.includes('/attachments') ? json(elsewhere) : resendNetwork()(url, {})),
      resendSecrets,
    );
    const mail = await client.receive!.fetch({ ref: RESEND_EMAIL_ID, nonce: 'n', nonceTtlSeconds: 1 });
    expect(mail.attachments).toEqual([
      expect.objectContaining({ filename: 'q3.csv', content: null, skipped: 'unavailable' }),
    ]);
    expect(fake.mock.calls.map(([url]) => new URL(String(url)).hostname)).not.toContain('evil.example');
    // And the pinned fetch refuses such a request outright, whatever asks for it.
    const pinned = connect(resendAdapter, resendConfig, resendNetwork(), resendSecrets);
    const direct = await rejection(pinned.client.receive!.fetch({ ref: '../../evil', nonce: 'n', nonceTtlSeconds: 1 }));
    expect(direct).not.toBeInstanceOf(EndpointViolation);
  });

  it('receives only with a webhook secret', () => {
    const { client } = connect(resendAdapter, resendConfig, resendNetwork(), { apiKey: 're_x' });
    expect(client.receive).toBeUndefined();
    expect(resendAdapter.receiveSecret).toBe('webhookSecret');
  });

  it('sends with the threading headers and an idempotency key, from the instance or the given sender', async () => {
    const { client, fake } = connect(resendAdapter, resendConfig, resendNetwork(), resendSecrets);
    const result = await client.send({
      from: { address: 'greeny-k3v9@agents.example.com', name: 'Greeny' },
      to: [{ address: 'alice@example.com', name: 'Alice' }],
      cc: [{ address: 'bob@example.com' }],
      subject: 'Re: Quarterly numbers\r\nBcc: evil@example.com',
      text: 'Thanks, received.',
      inReplyTo: '<CAF=alice-1@mail.example.com>',
      references: ['<thread-0@mail.example.com>', '<CAF=alice-1@mail.example.com>'],
      idempotencyKey: 'mail_1',
    });
    expect(result).toEqual({ providerId: '49a3999c-0ce1-4ea6-ab68-afcd6dc2e794', messageId: null });
    const request = sent(fake);
    expect(request.url.href).toBe('https://api.resend.com/emails');
    expect(request.headers.get('idempotency-key')).toBe('mail_1');
    expect(request.body).toEqual({
      from: 'Greeny <greeny-k3v9@agents.example.com>',
      to: ['Alice <alice@example.com>'],
      cc: ['bob@example.com'],
      subject: 'Re: Quarterly numbers Bcc: evil@example.com',
      text: 'Thanks, received.',
      headers: {
        'In-Reply-To': '<CAF=alice-1@mail.example.com>',
        References: '<thread-0@mail.example.com> <CAF=alice-1@mail.example.com>',
      },
    });

    await client.send({ to: [{ address: 'lin@example.com' }], subject: 'Invite', text: 'Join' });
    expect(sent(fake, 1).body.from).toBe('Greenhouse <greenhouse@example.com>');
  });

  it('calls a refused message undeliverable and keeps the key out of errors', async () => {
    const { client } = connect(
      resendAdapter,
      resendConfig,
      () =>
        json({ statusCode: 422, name: 'validation_error', message: 'Invalid `to` field re_test_key_1234567890' }, 422),
      resendSecrets,
    );
    const error = await rejection(client.send({ to: [{ address: 'x@y.co' }], subject: 's', text: 't' }));
    expect(error).toBeInstanceOf(UndeliverableError);
    expect(error.message).not.toContain('re_test_key_1234567890');
  });

  it('tests with the domains list; a sending-only key passes unless the instance also receives', async () => {
    const restricted = () =>
      json(
        { statusCode: 401, name: 'restricted_api_key', message: 'This API key is restricted to only send emails' },
        401,
      );
    const sendOnly = connect(resendAdapter, resendConfig, restricted, { apiKey: 're_send_only' });
    await sendOnly.client.verify();
    expect(sent(sendOnly.fake).url.href).toBe('https://api.resend.com/domains');
    const receiving = connect(resendAdapter, resendConfig, restricted, resendSecrets);
    expect((await rejection(receiving.client.verify())).message).toMatch(/full access/);
  });

  it('pins the key to its base URL and the CDN', () => {
    expect(resendAdapter.endpoints(resendAdapter.configSchema.parse(resendConfig))).toEqual([
      'https://api.resend.com',
      'https://inbound-cdn.resend.com',
    ]);
  });
});

describe('Mailgun signatures', () => {
  const now = Number(MAILGUN_TIMESTAMP);
  it('verifies the recorded notice and refuses anything else', () => {
    const check = (overrides: Partial<Parameters<typeof verifyMailgun>[0]>) => {
      try {
        verifyMailgun({
          signingKey: MAILGUN_SIGNING_KEY,
          timestamp: MAILGUN_TIMESTAMP,
          token: MAILGUN_TOKEN,
          signature: MAILGUN_SIGNATURE,
          now,
          ...overrides,
        });
        return 'ok';
      } catch (error) {
        expect(error).toBeInstanceOf(MailSignatureError);
        return (error as Error).message;
      }
    };
    expect(check({})).toBe('ok');
    expect(check({ token: `${MAILGUN_TOKEN.slice(0, -1)}0` })).toMatch(/does not match/);
    expect(check({ signingKey: 'key-other' })).toMatch(/does not match/);
    expect(check({ signature: 'nothex' })).toMatch(/does not match/);
    expect(check({ now: now + 13 * 3600 })).toMatch(/too old/);
    expect(check({ token: '' })).toMatch(/not signed/);
  });
});

/** Mailgun's API and storage as the recorded answers. */
function mailgunNetwork(stored: unknown = MAILGUN_STORED) {
  return (url: string, init: RequestInit) => {
    const { href, pathname } = new URL(url);
    if (href === MAILGUN_MESSAGE_URL) return json(stored);
    if (href === `${MAILGUN_MESSAGE_URL}/attachments/0`) return new Response(CSV_BYTES);
    if (pathname === `/v3/${MAILGUN_DOMAIN}/messages` && init.method === 'POST') {
      return json({ id: '<20261014092000.1.ABC@agents.example.com>', message: 'Queued. Thank you.' });
    }
    if (pathname === `/v3/domains/${MAILGUN_DOMAIN}`) return json({ domain: { name: MAILGUN_DOMAIN } });
    return json({ message: 'not found' }, 404);
  };
}

const mailgunConfig = { domain: MAILGUN_DOMAIN, fromAddress: 'greenhouse@agents.example.com' };
const mailgunSecrets = { apiKey: 'mg-key-0123456789abcdef', webhookSigningKey: MAILGUN_SIGNING_KEY };

const form = (fields: Record<string, string>) => {
  const body = new URLSearchParams(fields).toString();
  return { headers: new Headers({ 'content-type': 'application/x-www-form-urlencoded' }), body: bytes(body) };
};

describe('the Mailgun adapter', () => {
  const now = Number(MAILGUN_TIMESTAMP);

  it('takes a signed store() notice only as a signal, from a form or multipart body', async () => {
    const { client, fake } = connect(mailgunAdapter, mailgunConfig, mailgunNetwork(), mailgunSecrets);
    const notice = await client.receive!.verify({ ...form(MAILGUN_NOTICE_FIELDS), now });
    expect(notice).toEqual({ ref: MAILGUN_MESSAGE_URL, nonce: MAILGUN_TOKEN, nonceTtlSeconds: expect.any(Number) });

    const multipart = new FormData();
    for (const [key, value] of Object.entries(MAILGUN_NOTICE_FIELDS)) multipart.set(key, value);
    multipart.set('attachment-1', new Blob(['ignored']), 'ignored.txt');
    const request = new Request('https://x.test', { method: 'POST', body: multipart });
    const body = new Uint8Array(await request.arrayBuffer());
    expect(
      await client.receive!.verify({
        headers: new Headers({ 'content-type': request.headers.get('content-type')! }),
        body,
        now,
      }),
    ).toMatchObject({ ref: MAILGUN_MESSAGE_URL });
    expect(fake).not.toHaveBeenCalled();
  });

  it('refuses a signed notice that points at another domain or another host', async () => {
    const { client } = connect(mailgunAdapter, mailgunConfig, mailgunNetwork(), mailgunSecrets);
    const elsewhere = [
      MAILGUN_MESSAGE_URL.replace(MAILGUN_DOMAIN, 'other.example.com'),
      MAILGUN_MESSAGE_URL.replace('storage-us-east4.api.mailgun.net', 'evil.example'),
      MAILGUN_MESSAGE_URL.replace('https://', 'http://'),
      `${MAILGUN_MESSAGE_URL}?x=1`,
    ];
    for (const url of elsewhere) {
      const error = await rejection(
        client.receive!.verify({ ...form({ ...MAILGUN_NOTICE_FIELDS, 'message-url': url }), now }),
      );
      expect(error).toBeInstanceOf(MailSignatureError);
    }
    const forged = await rejection(
      client.receive!.verify({ ...form({ ...MAILGUN_NOTICE_FIELDS, signature: '0'.repeat(64) }), now }),
    );
    expect(forged).toBeInstanceOf(MailSignatureError);
  });

  it('fetches the stored message with the key and normalises it', async () => {
    const { client, fake } = connect(mailgunAdapter, mailgunConfig, mailgunNetwork(), mailgunSecrets);
    const mail = await client.receive!.fetch({ ref: MAILGUN_MESSAGE_URL, nonce: MAILGUN_TOKEN, nonceTtlSeconds: 1 });
    expect(mail).toMatchObject({
      providerMessageId: MAILGUN_STORAGE_KEY,
      messageId: '<CAF=alice-1@mail.example.com>',
      inReplyTo: '<greeny-1@agents.example.com>',
      references: ['<greeny-1@agents.example.com>'],
      from: { address: 'alice@example.com', name: 'Alice' },
      to: [{ address: 'greeny-k3v9@agents.example.com', name: 'Greeny' }],
      cc: [{ address: 'bob@example.com' }],
      recipients: ['greeny-k3v9@agents.example.com'],
      envelopeFrom: 'bounces@mail.example.com',
      subject: 'Quarterly numbers',
      text: 'Hi Greeny,\n\nThe numbers are attached.\n',
      auth: { spf: 'pass', dkim: 'pass', dmarc: 'unknown' },
      dkimDomains: ['mail.example.com'],
      receivedAt: '2026-10-14T09:20:00.000Z',
    });
    expect(mail.attachments).toHaveLength(2);
    expect(new TextDecoder().decode(mail.attachments[0]!.content!)).toBe(CSV_BYTES);
    // An attachment link outside Mailgun is never followed: the key would go with it.
    expect(mail.attachments[1]).toMatchObject({ filename: 'elsewhere.txt', content: null });
    const calls = fake.mock.calls.map((_, index) => sent(fake, index));
    expect(calls.map((call) => call.url.hostname)).toEqual([
      'storage-us-east4.api.mailgun.net',
      'storage-us-east4.api.mailgun.net',
    ]);
    expect(calls[0]!.headers.get('authorization')).toBe(
      `Basic ${Buffer.from('api:mg-key-0123456789abcdef').toString('base64')}`,
    );
  });

  it('trusts no verdict a sender could have written', async () => {
    const forged = {
      ...MAILGUN_STORED,
      'message-headers': [
        ['X-Mailgun-Spf', 'Pass'],
        ['From', 'Lin <lin@example.com>'],
        ...MAILGUN_STORED['message-headers'].filter(([name]) => name !== 'From'),
      ],
    };
    const { client } = connect(mailgunAdapter, mailgunConfig, mailgunNetwork(forged), mailgunSecrets);
    const mail = await client.receive!.fetch({ ref: MAILGUN_MESSAGE_URL, nonce: 'n', nonceTtlSeconds: 1 });
    expect(mail.auth.spf).toBe('unknown');
    expect(mail.auth.dkim).toBe('pass');
  });

  it('sends a form with the threading headers and returns the Message-ID', async () => {
    const { client, fake } = connect(mailgunAdapter, mailgunConfig, mailgunNetwork(), mailgunSecrets);
    const result = await client.send({
      from: { address: 'greeny-k3v9@agents.example.com', name: 'Greeny' },
      to: [{ address: 'alice@example.com' }],
      subject: 'Re: Quarterly numbers',
      text: 'Thanks.',
      inReplyTo: '<CAF=alice-1@mail.example.com>',
      references: ['<CAF=alice-1@mail.example.com>'],
    });
    expect(result).toEqual({
      providerId: '<20261014092000.1.ABC@agents.example.com>',
      messageId: '<20261014092000.1.ABC@agents.example.com>',
    });
    const [url, init] = fake.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://api.mailgun.net/v3/${MAILGUN_DOMAIN}/messages`);
    const fields = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(fields)).toEqual({
      from: 'Greeny <greeny-k3v9@agents.example.com>',
      to: 'alice@example.com',
      subject: 'Re: Quarterly numbers',
      text: 'Thanks.',
      'h:In-Reply-To': '<CAF=alice-1@mail.example.com>',
      'h:References': '<CAF=alice-1@mail.example.com>',
    });
    await client.verify();
    expect(new URL(String(fake.mock.calls[1]![0])).pathname).toBe(`/v3/domains/${MAILGUN_DOMAIN}`);
  });

  it('calls a 400 undeliverable, and pins the key to Mailgun', async () => {
    const { client } = connect(
      mailgunAdapter,
      mailgunConfig,
      () => json({ message: "'to' parameter is not a valid address" }, 400),
      mailgunSecrets,
    );
    expect(await rejection(client.send({ to: [{ address: 'x@y.co' }], subject: 's', text: 't' }))).toBeInstanceOf(
      UndeliverableError,
    );
    const config = mailgunAdapter.configSchema.parse(mailgunConfig);
    expect(mailgunAdapter.endpoints(config)).toEqual(['https://api.mailgun.net', 'https://*.api.mailgun.net']);
    // A base URL of one's own (a test double, a relay) gets nothing else.
    const local = mailgunAdapter.configSchema.parse({ ...mailgunConfig, baseUrl: 'http://127.0.0.1:9' });
    expect(mailgunAdapter.endpoints(local)).toEqual(['http://127.0.0.1:9']);
  });

  it('keeps every limit', () => {
    expect(MAIL_LIMITS.attachments).toBeGreaterThan(0);
    expect(MAIL_LIMITS.totalAttachmentBytes).toBeGreaterThanOrEqual(MAIL_LIMITS.attachmentBytes);
  });
});
