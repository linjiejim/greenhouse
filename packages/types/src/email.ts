/**
 * Email wire types + the provider preset table.
 *
 * SINGLE SOURCE OF TRUTH for the IMAP/SMTP presets. The settings form fills
 * host/port from here, and the API validates against the same table, so a
 * "Feishu" account can never end up pointing at someone else's server because
 * two lists drifted.
 *
 * There is no OAuth here by design: every account is generic IMAP/SMTP,
 * including Gmail (app password). See docs/specs/20260805-email-revival.md D1.
 */

export type EmailPresetId = 'feishu' | 'exmail' | 'gmail' | 'qq' | '163' | 'custom';

export interface EmailPreset {
  id: EmailPresetId;
  /** Display label — English, matching the rest of the settings chrome. */
  label: string;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  use_tls: boolean;
  /** i18n key for the "how do I get the password" steps shown under the form. */
  help_key: string;
  /** Where the user generates the password — opened in a new tab. */
  help_url?: string;
}

export const EMAIL_PRESETS: readonly EmailPreset[] = [
  {
    id: 'feishu',
    label: 'Feishu (飞书邮箱)',
    imap_host: 'imap.feishu.cn',
    imap_port: 993,
    smtp_host: 'smtp.feishu.cn',
    smtp_port: 465,
    use_tls: true,
    help_key: 'emailAccounts.help.feishu',
    help_url: 'https://mail.feishu.cn',
  },
  {
    id: 'exmail',
    label: 'Tencent Exmail (企业微信邮箱)',
    imap_host: 'imap.exmail.qq.com',
    imap_port: 993,
    smtp_host: 'smtp.exmail.qq.com',
    smtp_port: 465,
    use_tls: true,
    help_key: 'emailAccounts.help.exmail',
    help_url: 'https://exmail.qq.com',
  },
  {
    id: 'gmail',
    label: 'Gmail',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    use_tls: true,
    help_key: 'emailAccounts.help.gmail',
    help_url: 'https://myaccount.google.com/apppasswords',
  },
  {
    id: 'qq',
    label: 'QQ Mail (QQ 邮箱)',
    imap_host: 'imap.qq.com',
    imap_port: 993,
    smtp_host: 'smtp.qq.com',
    smtp_port: 465,
    use_tls: true,
    help_key: 'emailAccounts.help.qq',
    help_url: 'https://mail.qq.com',
  },
  {
    id: '163',
    label: '163 Mail (163 邮箱)',
    imap_host: 'imap.163.com',
    imap_port: 993,
    smtp_host: 'smtp.163.com',
    smtp_port: 465,
    use_tls: true,
    help_key: 'emailAccounts.help.163',
    help_url: 'https://mail.163.com',
  },
  {
    id: 'custom',
    label: 'Custom (自定义)',
    imap_host: '',
    imap_port: 993,
    smtp_host: '',
    smtp_port: 465,
    use_tls: true,
    help_key: 'emailAccounts.help.custom',
  },
];

export function getEmailPreset(id: string): EmailPreset | undefined {
  return EMAIL_PRESETS.find((p) => p.id === id);
}

// ─── Wire shapes ─────────────────────────────────────────

/** An account as returned to the browser — never carries the password. */
export interface EmailAccountView {
  id: number;
  email_address: string;
  display_name: string | null;
  preset: EmailPresetId;
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

/** Result of the "Test connection" button — IMAP and SMTP reported separately. */
export interface EmailConnectionTestResult {
  imap: { ok: boolean; error?: string };
  smtp: { ok: boolean; error?: string };
}
