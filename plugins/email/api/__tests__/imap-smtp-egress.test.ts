import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dnsLookup = vi.hoisted(() => vi.fn());
vi.mock('node:dns/promises', () => ({ lookup: dnsLookup }));

import { ImapFlow } from 'imapflow';
import { MailboxError, describeImapError, guardImapClientErrors, planConnection } from '../imap-smtp-client.js';

describe('mail egress connection planning', () => {
  beforeEach(() => {
    process.env.MAIL_EGRESS_PROXY = 'socks5://proxy.example:1080';
    dnsLookup.mockReset();
  });

  afterEach(() => {
    delete process.env.MAIL_EGRESS_PROXY;
  });

  it('pins the validated public IP even when a proxy is used', async () => {
    dnsLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    await expect(planConnection('mail.example.com', true)).resolves.toEqual({
      host: '8.8.8.8',
      servername: 'mail.example.com',
      proxy: 'socks5://proxy.example:1080',
    });
  });

  it('rejects mixed public/private DNS answers instead of picking the public one', async () => {
    dnsLookup.mockResolvedValue([
      { address: '8.8.8.8', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]);
    await expect(planConnection('mail.example.com', true)).rejects.toBeInstanceOf(MailboxError);
  });
});

describe('imap client error handling', () => {
  it('a guarded client survives late socket errors instead of crashing the process', () => {
    const client = new ImapFlow({ host: '127.0.0.1', port: 993, auth: { user: 'u', pass: 'p' }, logger: false });
    guardImapClientErrors(client, 'user@example.com');
    // Without a listener, emitting 'error' on an EventEmitter throws — which at
    // runtime is an uncaught exception that kills the API (seen on dev: every
    // failed binding attempt crashed the process ~15s later).
    const err = Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' });
    expect(() => client.emit('error', err)).not.toThrow();
  });

  it('surfaces the server rejection text hidden behind "Command failed"', () => {
    const err = Object.assign(new Error('Command failed'), {
      responseText: 'LOGIN Login error user name or password error',
    });
    expect(describeImapError(err)).toBe('Command failed — server said: LOGIN Login error user name or password error');
    expect(describeImapError(new Error('Command failed'))).toBe('Command failed');
  });
});
