/**
 * A member's mailboxes (`/api/email/accounts`): the form's draft, what each save sends and how a
 * connection test reads (./screen*.tsx). The password is write-only: no account the station
 * answers carries it, a draft never starts with one, and an edit sends it only when retyped.
 * React-free.
 */

/** An account as `toView()` in plugins/email/api/routes.ts answers it (never a password). */
export interface EmailAccount {
  id: string;
  email_address: string;
  display_name: string | null;
  preset: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  use_tls: boolean;
  use_proxy: boolean;
  username: string;
  status: 'active' | 'disabled' | 'error';
  error_message: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

/** `GET /api/email/presets` (packages/types/src/email.ts `EMAIL_PRESETS`). */
export interface EmailPreset {
  id: string;
  label: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  use_tls: boolean;
  help_url?: string;
}

/** `{ imap, smtp }` from a save or `POST /accounts/:id/test`. */
export interface ConnectionTest {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}

/** Presets the client has words for; any other id the station sends reads as custom. */
export const KNOWN_PRESETS = ['feishu', 'exmail', 'gmail', 'qq', '163', 'custom'] as const;
export type KnownPreset = (typeof KNOWN_PRESETS)[number];
export const presetKey = (id: string): KnownPreset =>
  (KNOWN_PRESETS as readonly string[]).includes(id) ? (id as KnownPreset) : 'custom';

/** Form values; ports stay text while typed. */
export interface EmailDraft {
  preset: string;
  email_address: string;
  display_name: string;
  username: string;
  password: string;
  imap_host: string;
  imap_port: string;
  smtp_host: string;
  smtp_port: string;
  use_tls: boolean;
  use_proxy: boolean;
}

const CUSTOM: EmailPreset = {
  id: 'custom',
  label: 'Custom',
  imap_host: '',
  imap_port: 993,
  smtp_host: '',
  smtp_port: 465,
  use_tls: true,
};

/** A new mailbox on a provider: its servers filled in, nothing typed yet. */
export function newDraft(preset: EmailPreset = CUSTOM): EmailDraft {
  return applyPreset(
    {
      preset: preset.id,
      email_address: '',
      display_name: '',
      username: '',
      password: '',
      imap_host: '',
      imap_port: '',
      smtp_host: '',
      smtp_port: '',
      use_tls: true,
      use_proxy: false,
    },
    preset,
  );
}

/** Switching provider replaces the servers and keeps what the member typed. */
export function applyPreset(draft: EmailDraft, preset: EmailPreset): EmailDraft {
  return {
    ...draft,
    preset: preset.id,
    imap_host: preset.imap_host,
    imap_port: String(preset.imap_port),
    smtp_host: preset.smtp_host,
    smtp_port: String(preset.smtp_port),
    use_tls: preset.use_tls,
  };
}

/** An account's values to edit; the password field starts empty (empty = keep the saved one). */
export function draftOf(account: EmailAccount): EmailDraft {
  return {
    preset: account.preset,
    email_address: account.email_address,
    display_name: account.display_name ?? '',
    username: account.username === account.email_address ? '' : account.username,
    password: '',
    imap_host: account.imap_host,
    imap_port: String(account.imap_port),
    smtp_host: account.smtp_host,
    smtp_port: String(account.smtp_port),
    use_tls: account.use_tls,
    use_proxy: account.use_proxy,
  };
}

export type DraftProblem = 'email' | 'password' | 'imapHost' | 'imapPort' | 'smtpHost' | 'smtpPort';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function port(value: string): number | null {
  const n = Number(value.trim());
  return /^\d+$/.test(value.trim()) && n >= 1 && n <= 65535 ? n : null;
}

/** The first field a save would be refused for, in form order; null when it may be sent. */
export function draftProblem(draft: EmailDraft, editing: boolean): DraftProblem | null {
  if (!editing && !EMAIL.test(draft.email_address.trim())) return 'email';
  if (!editing && !draft.password.trim()) return 'password';
  if (!draft.imap_host.trim()) return 'imapHost';
  if (port(draft.imap_port) === null) return 'imapPort';
  if (!draft.smtp_host.trim()) return 'smtpHost';
  if (port(draft.smtp_port) === null) return 'smtpPort';
  return null;
}

/** `POST /api/email/accounts`: every field; an empty sign-in name means the address. */
export function createBody(draft: EmailDraft) {
  const username = draft.username.trim();
  return {
    email_address: draft.email_address.trim(),
    display_name: draft.display_name.trim() || null,
    preset: draft.preset,
    imap_host: draft.imap_host.trim(),
    imap_port: port(draft.imap_port),
    smtp_host: draft.smtp_host.trim(),
    smtp_port: port(draft.smtp_port),
    use_tls: draft.use_tls,
    use_proxy: draft.use_proxy,
    ...(username ? { username } : {}),
    password: draft.password.trim(),
  };
}

/**
 * `PUT /api/email/accounts/:id`: only what changed. The address and provider are fixed once
 * bound; the password goes only when retyped. Empty when nothing changed.
 */
export function updateBody(account: EmailAccount, draft: EmailDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const name = draft.display_name.trim() || null;
  if (name !== (account.display_name ?? null)) body.display_name = name;
  const username = draft.username.trim() || account.email_address;
  if (username !== account.username) body.username = username;
  if (draft.imap_host.trim() !== account.imap_host) body.imap_host = draft.imap_host.trim();
  if (port(draft.imap_port) !== account.imap_port) body.imap_port = port(draft.imap_port);
  if (draft.smtp_host.trim() !== account.smtp_host) body.smtp_host = draft.smtp_host.trim();
  if (port(draft.smtp_port) !== account.smtp_port) body.smtp_port = port(draft.smtp_port);
  if (draft.use_tls !== account.use_tls) body.use_tls = draft.use_tls;
  if (draft.use_proxy !== account.use_proxy) body.use_proxy = draft.use_proxy;
  if (draft.password.trim()) body.password = draft.password.trim();
  return body;
}

/** The provider's own words for each failed side (`IMAP: …`), empty when both worked. */
export function testFailures(test: ConnectionTest | null | undefined): string[] {
  if (!test) return [];
  return [
    ...(test.imap.ok ? [] : [`IMAP: ${test.imap.error || '—'}`]),
    ...(test.smtp.ok ? [] : [`SMTP: ${test.smtp.error || '—'}`]),
  ];
}

export const accountTitle = (account: EmailAccount) => account.display_name?.trim() || account.email_address;

/** Badge words key and tone for an account's standing. */
export function accountStanding(account: EmailAccount): { key: 'active' | 'error' | 'disabled'; tone: 'green' | 'red' | 'neutral' } {
  if (account.status === 'error') return { key: 'error', tone: 'red' };
  if (account.status === 'disabled') return { key: 'disabled', tone: 'neutral' };
  return { key: 'active', tone: 'green' };
}
