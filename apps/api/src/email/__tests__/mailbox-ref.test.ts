/**
 * How a mailbox reference written by the model is read.
 *
 * `list_accounts` returns a numeric `mailbox` and an `email_address`, so both
 * forms show up in calls. The address form used to fail the numeric parse and
 * come back as "mailbox is required" — the one thing that was demonstrably not
 * true about a call that passed one.
 */

import { describe, expect, it } from 'vitest';
import { mailboxRefError, parseMailboxRef } from '../service.js';

describe('parseMailboxRef', () => {
  it('reads account ids, "shared" and addresses', () => {
    expect(parseMailboxRef('7')).toBe(7);
    expect(parseMailboxRef(7)).toBe(7);
    expect(parseMailboxRef('shared')).toBe('shared');
    expect(parseMailboxRef('Jim@Example.com')).toEqual({ address: 'jim@example.com' });
  });

  it('rejects what is neither', () => {
    expect(parseMailboxRef(undefined)).toBeNull();
    expect(parseMailboxRef('')).toBeNull();
    expect(parseMailboxRef('   ')).toBeNull();
    expect(parseMailboxRef('INBOX')).toBeNull();
    expect(parseMailboxRef(0)).toBeNull();
    expect(parseMailboxRef(-2)).toBeNull();
  });
});

describe('mailboxRefError', () => {
  it('only says "required" when nothing was passed', () => {
    expect(mailboxRefError(undefined)).toContain('required');
    expect(mailboxRefError('')).toContain('required');
  });

  it('quotes what it was given and points at list_accounts', () => {
    const message = mailboxRefError('INBOX');
    expect(message).toContain('"INBOX"');
    expect(message).toContain('list_accounts');
    expect(message).not.toContain('required');
  });
});
