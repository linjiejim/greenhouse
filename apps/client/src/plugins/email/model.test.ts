import { describe, expect, it } from 'vitest';
import {
  accountStanding,
  applyPreset,
  createBody,
  draftOf,
  draftProblem,
  newDraft,
  presetKey,
  testFailures,
  updateBody,
  type EmailAccount,
  type EmailPreset,
} from './model';

const gmail: EmailPreset = {
  id: 'gmail',
  label: 'Gmail',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  use_tls: true,
};
const account: EmailAccount = {
  id: 'ema_1',
  email_address: 'jim@example.com',
  display_name: 'Jim',
  preset: 'gmail',
  imap_host: 'imap.gmail.com',
  imap_port: 993,
  smtp_host: 'smtp.gmail.com',
  smtp_port: 465,
  use_tls: true,
  use_proxy: false,
  username: 'jim@example.com',
  status: 'active',
  error_message: null,
  last_verified_at: '2026-10-28T10:00:00.000Z',
  created_at: '2026-10-01T10:00:00.000Z',
  updated_at: '2026-10-28T10:00:00.000Z',
};

describe('drafts', () => {
  it('fills a provider’s servers and keeps what was typed when switching', () => {
    const draft = { ...newDraft(), email_address: 'a@b.co', password: 'x' };
    expect(draft.imap_host).toBe('');
    expect(applyPreset(draft, gmail)).toMatchObject({
      preset: 'gmail',
      imap_host: 'imap.gmail.com',
      imap_port: '993',
      email_address: 'a@b.co',
      password: 'x',
    });
  });
  it('never starts an edit with a password, and hides a sign-in name equal to the address', () => {
    const draft = draftOf(account);
    expect(draft.password).toBe('');
    expect(draft.username).toBe('');
    expect(draftOf({ ...account, username: 'jim' }).username).toBe('jim');
  });
  it('names the first field a save would be refused for', () => {
    const draft = { ...newDraft(gmail), email_address: 'jim@example.com', password: 'app pass' };
    expect(draftProblem(draft, false)).toBeNull();
    expect(draftProblem({ ...draft, email_address: 'jim' }, false)).toBe('email');
    expect(draftProblem({ ...draft, password: '  ' }, false)).toBe('password');
    expect(draftProblem({ ...draft, password: '' }, true)).toBeNull();
    expect(draftProblem({ ...draft, imap_port: '99999' }, false)).toBe('imapPort');
    expect(draftProblem({ ...draft, smtp_host: ' ' }, false)).toBe('smtpHost');
  });
});

describe('bodies', () => {
  it('creates with every field, numeric ports and a trimmed password', () => {
    const draft = { ...newDraft(gmail), email_address: ' jim@example.com ', password: ' abcd efgh \n' };
    expect(createBody(draft)).toEqual({
      email_address: 'jim@example.com',
      display_name: null,
      preset: 'gmail',
      imap_host: 'imap.gmail.com',
      imap_port: 993,
      smtp_host: 'smtp.gmail.com',
      smtp_port: 465,
      use_tls: true,
      use_proxy: false,
      password: 'abcd efgh',
    });
    expect(createBody({ ...draft, username: 'jim' }).username).toBe('jim');
  });
  it('updates only what changed and sends the password only when retyped', () => {
    expect(updateBody(account, draftOf(account))).toEqual({});
    expect(updateBody(account, { ...draftOf(account), display_name: 'Work', smtp_port: '587', password: 'new' })).toEqual({
      display_name: 'Work',
      smtp_port: 587,
      password: 'new',
    });
    // clearing the sign-in name means "the address" again
    expect(updateBody({ ...account, username: 'jim' }, { ...draftOf(account), username: '' })).toEqual({
      username: 'jim@example.com',
    });
  });
});

it('reads test results, standings and unknown presets', () => {
  expect(testFailures({ imap: { ok: true }, smtp: { ok: false, error: 'Auth failed' } })).toEqual(['SMTP: Auth failed']);
  expect(testFailures({ imap: { ok: true }, smtp: { ok: true } })).toEqual([]);
  expect(testFailures(undefined)).toEqual([]);
  expect(accountStanding({ ...account, status: 'error' })).toEqual({ key: 'error', tone: 'red' });
  expect(presetKey('outlook')).toBe('custom');
  expect(presetKey('163')).toBe('163');
});
