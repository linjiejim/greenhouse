/**
 * Email mailbox resolution + send guardrails (real PostgreSQL).
 *
 * The send path is the only way a message leaves the building, so its ordering
 * is the contract: ownership → recipient policy → rate limit → attachment
 * budget → send → audit. Everything here asserts that a rejection happens
 * BEFORE the transport is touched — the fake client records whether it was
 * called, and for a rejected send it must not have been.
 *
 * The shared mailbox is env-configured rather than a row, so these tests set
 * and restore SHARED_MAILBOX_* around the cases that need it.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetProvider, initDatabase, type DatabaseProvider, type UserRow } from '@greenhouse/db';
import { TEST_DATABASE_URL } from '@greenhouse/db/test-config';
import { createInternalTestUser } from '../../../../../tests/helpers/internal-user.js';
import { encryptToken } from '../../auth/crypto.js';
import {
  getSharedMailboxCredentials,
  isSharedMailboxConfigured,
  parseMailboxRef,
  resolveMailbox,
  sendMail,
} from '../service.js';
import { MAX_PERSONAL_SENDS_PER_DAY, MAX_RECIPIENTS_PER_MESSAGE, MAX_SHARED_SENDS_PER_DAY } from '../limits.js';
import type { ResolvedMailbox } from '../service.js';
import type { SendEmailOptions } from '../types.js';

let db: DatabaseProvider;
const ORIGINAL_ENV = { ...process.env };

/** Stands in for ImapSmtpClient — records calls so we can assert non-delivery. */
function fakeMailbox(overrides: Partial<ResolvedMailbox> = {}): ResolvedMailbox & { sent: SendEmailOptions[] } {
  const sent: SendEmailOptions[] = [];
  const mailbox = {
    ref: 1 as const,
    scope: 'personal' as const,
    address: 'jim@example.com',
    displayName: null,
    accountId: 1,
    sent,
    client: {
      async sendEmail(opts: SendEmailOptions) {
        sent.push(opts);
        return { messageId: '<generated@example.com>' };
      },
    },
    ...overrides,
  };
  return mailbox as unknown as ResolvedMailbox & { sent: SendEmailOptions[] };
}

async function bindMailbox(user: UserRow, address = user.email) {
  return await db.email.createAccount({
    user_id: user.id,
    email_address: address,
    imap_host: 'imap.feishu.cn',
    imap_port: 993,
    smtp_host: 'smtp.feishu.cn',
    smtp_port: 465,
    username: address,
    password_encrypted: encryptToken('secret'),
    preset: 'feishu',
  });
}

beforeEach(async () => {
  process.env.PROVIDER_TOKEN_ENCRYPTION_KEY = 'a'.repeat(64);
  _resetProvider();
  db = await initDatabase({ type: 'pg', pgConnectionString: TEST_DATABASE_URL });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

function configureSharedMailbox() {
  process.env.SHARED_MAILBOX_ADDRESS = 'greenhouse@example.com';
  process.env.SHARED_MAILBOX_PASSWORD = 'shared-secret';
  process.env.SHARED_MAILBOX_IMAP_HOST = 'imap.feishu.cn';
  process.env.SHARED_MAILBOX_SMTP_HOST = 'smtp.feishu.cn';
}

describe('shared mailbox configuration', () => {
  it('reports itself unconfigured when any required variable is missing', () => {
    configureSharedMailbox();
    delete process.env.SHARED_MAILBOX_PASSWORD;
    expect(isSharedMailboxConfigured()).toBe(false);
    expect(getSharedMailboxCredentials()).toBeNull();
  });

  it('defaults ports, username and display name from the address', () => {
    configureSharedMailbox();
    const creds = getSharedMailboxCredentials()!;
    expect(creds.imap_port).toBe(993);
    expect(creds.smtp_port).toBe(465);
    expect(creds.username).toBe('greenhouse@example.com');
    expect(creds.display_name).toBe('Greenhouse');
  });
});

describe('resolveMailbox', () => {
  it('resolves a mailbox its owner asks for', async () => {
    const user = await createInternalTestUser(db, { email: `owner-${Date.now()}@example.com` });
    const account = await bindMailbox(user);

    const result = await resolveMailbox(db, { userId: user.id, userRole: user.role }, account.id);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mailbox.address).toBe(user.email);
  });

  it("gives the same answer for someone else's mailbox as for one that does not exist", async () => {
    const owner = await createInternalTestUser(db, { email: `a-${Date.now()}@example.com` });
    const other = await createInternalTestUser(db, { email: `b-${Date.now()}@example.com` });
    const account = await bindMailbox(owner);

    const foreign = await resolveMailbox(db, { userId: other.id, userRole: other.role }, account.id);
    const missing = await resolveMailbox(db, { userId: other.id, userRole: other.role }, 999_999);

    expect(foreign.ok).toBe(false);
    expect(missing.ok).toBe(false);
    // Identical wording: a probe must not learn that the row exists.
    if (!foreign.ok && !missing.ok) {
      expect(foreign.error.replace(String(account.id), 'X')).toBe(missing.error.replace('999999', 'X'));
    }
  });

  it('refuses a disabled mailbox', async () => {
    const user = await createInternalTestUser(db, { email: `disabled-${Date.now()}@example.com` });
    const account = await bindMailbox(user);
    await db.email.updateAccount(account.id, { status: 'disabled' });

    const result = await resolveMailbox(db, { userId: user.id, userRole: user.role }, account.id);
    expect(result.ok).toBe(false);
  });

  it('keeps the shared mailbox away from team users', async () => {
    configureSharedMailbox();
    const user = await createInternalTestUser(db, { email: `team-${Date.now()}@example.com`, role: 'team' });

    const result = await resolveMailbox(db, { userId: user.id, userRole: user.role }, 'shared');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/administrator/i);
  });

  it('gives a super the shared mailbox when it is configured', async () => {
    configureSharedMailbox();
    const user = await createInternalTestUser(db, { email: `super-${Date.now()}@example.com`, role: 'super' });

    const result = await resolveMailbox(db, { userId: user.id, userRole: user.role }, 'shared');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.mailbox.address).toBe('greenhouse@example.com');
  });

  // list_accounts reports both `mailbox` and `email_address`; the model passes
  // either, and the address form used to fail as "mailbox is required".
  it('resolves a mailbox by the address list_accounts reported', async () => {
    const user = await createInternalTestUser(db, { email: `byaddr-${Date.now()}@example.com` });
    const account = await bindMailbox(user);

    const ref = parseMailboxRef(user.email.toUpperCase());
    const result = await resolveMailbox(db, { userId: user.id, userRole: user.role }, ref!);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mailbox.address).toBe(user.email);
      // Normalized back to the account id, so a draft token round-trips.
      expect(result.mailbox.ref).toBe(account.id);
    }
  });

  it('does not resolve an address bound to someone else', async () => {
    const owner = await createInternalTestUser(db, { email: `own-${Date.now()}@example.com` });
    const other = await createInternalTestUser(db, { email: `oth-${Date.now()}@example.com` });
    await bindMailbox(owner);

    const result = await resolveMailbox(db, { userId: other.id, userRole: other.role }, parseMailboxRef(owner.email)!);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('list_accounts');
  });

  it('keeps the super-only gate when the shared mailbox is named by address', async () => {
    configureSharedMailbox();
    const user = await createInternalTestUser(db, { email: `teamaddr-${Date.now()}@example.com`, role: 'team' });

    const result = await resolveMailbox(
      db,
      { userId: user.id, userRole: user.role },
      parseMailboxRef('greenhouse@example.com')!,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/administrator/i);
  });

  it('says so plainly when a super asks for a shared mailbox that was never configured', async () => {
    const user = await createInternalTestUser(db, { email: `super2-${Date.now()}@example.com`, role: 'super' });
    const result = await resolveMailbox(db, { userId: user.id, userRole: user.role }, 'shared');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('SHARED_MAILBOX');
  });
});

describe('sendMail guardrails', () => {
  const message = { to: [{ address: 'someone@example.com' }], subject: 'Hi', body_text: 'Body' };

  it('sends and writes an audit row', async () => {
    const user = await createInternalTestUser(db, { email: `send-${Date.now()}@example.com` });
    const mailbox = fakeMailbox();

    const result = await sendMail(db, mailbox, message, { userId: user.id, origin: 'chat', sessionId: 's-1' });
    expect(result.ok).toBe(true);
    expect(mailbox.sent).toHaveLength(1);

    const log = await db.email.listSendLog({ userId: user.id });
    expect(log).toHaveLength(1);
    expect(log[0]!.status).toBe('sent');
    expect(JSON.parse(log[0]!.recipients)).toEqual(['someone@example.com']);
    expect(log[0]!.session_id).toBe('s-1');
  });

  it('records a failed send rather than losing it', async () => {
    const user = await createInternalTestUser(db, { email: `fail-${Date.now()}@example.com` });
    const mailbox = fakeMailbox({
      client: {
        async sendEmail() {
          throw new Error('SMTP said no');
        },
      } as unknown as ResolvedMailbox['client'],
    });

    const result = await sendMail(db, mailbox, message, { userId: user.id, origin: 'chat' });
    expect(result.ok).toBe(false);

    const log = await db.email.listSendLog({ userId: user.id });
    expect(log[0]!.status).toBe('failed');
    expect(log[0]!.error_message).toContain('SMTP said no');
  });

  it('refuses an invalid address before touching the transport', async () => {
    const user = await createInternalTestUser(db, { email: `invalid-${Date.now()}@example.com` });
    const mailbox = fakeMailbox();

    const result = await sendMail(
      db,
      mailbox,
      { ...message, cc: [{ address: 'not-an-address' }] },
      { userId: user.id, origin: 'chat' },
    );
    expect(result.ok).toBe(false);
    expect(mailbox.sent).toHaveLength(0);
  });

  it('caps recipients per message', async () => {
    const user = await createInternalTestUser(db, { email: `many-${Date.now()}@example.com` });
    const mailbox = fakeMailbox();
    const to = Array.from({ length: MAX_RECIPIENTS_PER_MESSAGE + 1 }, (_, i) => ({ address: `p${i}@example.com` }));

    const result = await sendMail(db, mailbox, { ...message, to }, { userId: user.id, origin: 'chat' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_RECIPIENTS_PER_MESSAGE));
    expect(mailbox.sent).toHaveLength(0);
  });

  it('counts bcc against the recipient cap', async () => {
    const user = await createInternalTestUser(db, { email: `bcc-${Date.now()}@example.com` });
    const mailbox = fakeMailbox();
    const bcc = Array.from({ length: MAX_RECIPIENTS_PER_MESSAGE }, (_, i) => ({ address: `p${i}@example.com` }));

    const result = await sendMail(db, mailbox, { ...message, bcc }, { userId: user.id, origin: 'chat' });
    expect(result.ok).toBe(false);
    expect(mailbox.sent).toHaveLength(0);
  });

  it('stops a personal mailbox at its daily limit', async () => {
    const user = await createInternalTestUser(db, { email: `limit-${Date.now()}@example.com` });
    const mailbox = fakeMailbox();

    for (let i = 0; i < MAX_PERSONAL_SENDS_PER_DAY; i++) {
      await db.email.logSend({
        user_id: user.id,
        account_scope: 'personal',
        account_id: 1,
        from_address: user.email,
        subject: 'earlier',
        recipients: ['x@example.com'],
        origin: 'chat',
        status: 'sent',
      });
    }

    const result = await sendMail(db, mailbox, message, { userId: user.id, origin: 'chat' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_PERSONAL_SENDS_PER_DAY));
    expect(mailbox.sent).toHaveLength(0);
  });

  it('does not let failed sends consume the daily quota', async () => {
    const user = await createInternalTestUser(db, { email: `failquota-${Date.now()}@example.com` });
    const mailbox = fakeMailbox();

    for (let i = 0; i < MAX_PERSONAL_SENDS_PER_DAY; i++) {
      await db.email.logSend({
        user_id: user.id,
        account_scope: 'personal',
        account_id: 1,
        from_address: user.email,
        subject: 'bounced',
        recipients: ['x@example.com'],
        origin: 'chat',
        status: 'failed',
      });
    }

    const result = await sendMail(db, mailbox, message, { userId: user.id, origin: 'chat' });
    expect(result.ok).toBe(true);
  });

  it('holds the shared mailbox to its own, lower daily limit across all users', async () => {
    configureSharedMailbox();
    const a = await createInternalTestUser(db, { email: `sa-${Date.now()}@example.com`, role: 'super' });
    const b = await createInternalTestUser(db, { email: `sb-${Date.now()}@example.com`, role: 'super' });
    const mailbox = fakeMailbox({
      scope: 'shared',
      ref: 'shared',
      accountId: undefined,
      address: 'greenhouse@example.com',
    });

    // Spent by someone else — the cap is per mailbox, not per person.
    for (let i = 0; i < MAX_SHARED_SENDS_PER_DAY; i++) {
      await db.email.logSend({
        user_id: b.id,
        account_scope: 'shared',
        from_address: 'greenhouse@example.com',
        subject: 'earlier',
        recipients: ['x@example.com'],
        origin: 'automation',
        status: 'sent',
      });
    }

    const result = await sendMail(
      db,
      mailbox,
      { ...message, to: [{ address: a.email }] },
      { userId: a.id, origin: 'chat' },
    );
    expect(result.ok).toBe(false);
    expect(mailbox.sent).toHaveLength(0);
  });

  it('refuses an outside recipient from the shared mailbox', async () => {
    configureSharedMailbox();
    const user = await createInternalTestUser(db, { email: `policy-${Date.now()}@example.com`, role: 'super' });
    const mailbox = fakeMailbox({
      scope: 'shared',
      ref: 'shared',
      accountId: undefined,
      address: 'greenhouse@example.com',
    });

    const result = await sendMail(
      db,
      mailbox,
      { ...message, to: [{ address: 'outsider@elsewhere.test' }] },
      { userId: user.id, origin: 'chat' },
    );
    expect(result.ok).toBe(false);
    expect(mailbox.sent).toHaveLength(0);
  });

  it('lets the shared mailbox write to the sender and the company domain', async () => {
    configureSharedMailbox();
    const user = await createInternalTestUser(db, { email: `allowed-${Date.now()}@example.com`, role: 'super' });
    const mailbox = fakeMailbox({
      scope: 'shared',
      ref: 'shared',
      accountId: undefined,
      address: 'greenhouse@example.com',
    });

    const result = await sendMail(
      db,
      mailbox,
      { ...message, to: [{ address: user.email }, { address: 'colleague@example.com' }] },
      { userId: user.id, origin: 'chat' },
    );
    expect(result.ok).toBe(true);
    expect(mailbox.sent).toHaveLength(1);
  });

  it('does not apply the shared allowlist to a personal mailbox', async () => {
    const user = await createInternalTestUser(db, { email: `personal-${Date.now()}@example.com` });
    const mailbox = fakeMailbox();

    const result = await sendMail(
      db,
      mailbox,
      { ...message, to: [{ address: 'customer@example.com' }] },
      { userId: user.id, origin: 'chat' },
    );
    expect(result.ok).toBe(true);
  });
});
