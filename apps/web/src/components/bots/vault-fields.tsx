/**
 * Password vault form pieces: site parsing, 2FA secret checks, and the
 * write-only secret inputs used by Settings → Passwords.
 *
 * Sites bind a login to exact origins (spec §8, design-review R10): a Bot may
 * only fill it into a page whose main-frame origin matches. The member types
 * what they see in the address bar, so parsing is forgiving about form —
 * `github.com/login` becomes `https://github.com` — and strict about meaning:
 * https only (http just for local development hosts), no credentials in the
 * URL, and subdomains only when written explicitly as `*.example.com`. The
 * server re-validates; this is the fast, explainable first pass.
 *
 * Secrets are write-only: the API never returns them, so editing shows "leave
 * blank to keep" plus an explicit remove switch instead of a pre-filled value.
 */

import React from 'react';
import { Checkbox, Input, Tag, Textarea } from '../ui';
import { useT } from '../../lib/i18n';

export const VAULT_LABEL_MAX = 60;
export const VAULT_MAX_SITES = 20;

const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}$/;
// http is only for local test fixtures — and only where the server runs in development.
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1']);

function isDnsName(host: string): boolean {
  const labels = host.split('.');
  return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label)) && !/^\d+$/.test(labels.at(-1) ?? '');
}

function isIpv4(host: string): boolean {
  return IPV4.test(host) && host.split('.').every((part) => Number(part) <= 255);
}

/** IDN → punycode through the URL parser (the form the server and the browser compare). */
function parseHost(hostAndPort: string): URL | null {
  try {
    const url = new URL(`https://${hostAndPort}`);
    return url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

/**
 * One line of the Sites field → a canonical origin (`https://host[:port]`) or
 * wildcard (`*.host`), or null when it cannot be a site.
 */
export function normalizeSite(raw: string): string | null {
  let value = raw.trim();
  if (!value) return null;

  // Wildcards: "*.example.com", also when typed with the scheme in front.
  const wildcard = /^(?:https:\/\/)?\*\.([^/?#]+)\/?$/i.exec(value);
  if (wildcard) {
    const url = parseHost(wildcard[1]!);
    return url && isDnsName(url.hostname) ? `*.${url.host}` : null;
  }
  if (value.includes('*')) return null;

  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = `https://${value}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const host = url.hostname;
  if (url.protocol === 'https:') {
    if (!isDnsName(host) && !isIpv4(host) && !LOCAL_DEV_HOSTS.has(host)) return null;
  } else if (url.protocol === 'http:') {
    if (!LOCAL_DEV_HOSTS.has(host)) return null;
  } else {
    return null;
  }
  return `${url.protocol}//${url.host}`;
}

export interface ParsedSites {
  origins: string[];
  /** 1-based line numbers of lines that are not sites. */
  invalid: Array<{ line: number; value: string }>;
}

export function parseSiteLines(text: string): ParsedSites {
  const origins: string[] = [];
  const invalid: ParsedSites['invalid'] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const site = normalizeSite(line);
    if (!site) invalid.push({ line: index + 1, value: line.trim() });
    else if (!origins.includes(site)) origins.push(site);
  });
  return { origins, invalid };
}

/**
 * The Sites field: one site per line, with the exact origins it will be saved
 * as shown underneath — binding is exact, so the member should see that
 * `github.com/login` means `https://github.com` and nothing else.
 */
export function SitesField({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: unknown;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const t = useT();
  const text = typeof value === 'string' ? value : '';
  const { origins } = parseSiteLines(text);
  return (
    <div className="space-y-1.5">
      <Textarea
        rows={3}
        value={text}
        disabled={disabled}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        onChange={(event) => onChange(event.target.value)}
        data-testid="vault-field-sites"
      />
      {origins.length > 0 && (
        <div className="flex flex-wrap items-center gap-1" data-testid="vault-sites-preview">
          <span className="text-[11px] text-fg-faint">{t('botsVault.sitesPreview')}</span>
          {origins.map((origin) => (
            <Tag key={origin} tone="primary" truncate maxW="max-w-[220px]">
              {origin}
            </Tag>
          ))}
        </div>
      )}
    </div>
  );
}

const BASE32 = /^[A-Z2-7]+=*$/;

function isBase32Secret(secret: string): boolean {
  const compact = secret.replace(/[\s-]/g, '').toUpperCase();
  return compact.length >= 16 && BASE32.test(compact);
}

/**
 * A 2FA setup key as the member pasted it → what to send: an `otpauth://totp`
 * link as-is, or the base32 key without spaces/dashes. Null when it is neither.
 */
export function normalizeTotpSecret(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^otpauth:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      if (url.hostname.toLowerCase() !== 'totp') return null;
      const secret = url.searchParams.get('secret');
      return secret && isBase32Secret(secret) ? value : null;
    } catch {
      return null;
    }
  }
  return isBase32Secret(value) ? value.replace(/[\s-]/g, '').toUpperCase() : null;
}

// ─── Write-only secret input ─────────────────────────────

/** Form value of a write-only secret: new text, or an explicit request to remove the stored one. */
export interface SecretValue {
  value: string;
  clear: boolean;
}

export const EMPTY_SECRET: SecretValue = { value: '', clear: false };

export function asSecret(value: unknown): SecretValue {
  if (value && typeof value === 'object' && 'value' in value) {
    const v = value as Partial<SecretValue>;
    return { value: typeof v.value === 'string' ? v.value : '', clear: v.clear === true };
  }
  return EMPTY_SECRET;
}

/**
 * The write-side meaning of a secret field: `undefined` keeps what is stored,
 * `''` removes it, anything else replaces it (contract: VaultItemWrite).
 */
export function secretWrite(
  secret: SecretValue,
  normalize: (v: string) => string | null = (v) => v,
): string | undefined {
  if (secret.clear) return '';
  if (!secret.value) return undefined;
  return normalize(secret.value) ?? secret.value;
}

interface SecretInputProps {
  value: unknown;
  onChange: (value: SecretValue) => void;
  /** The item already stores this secret (edit mode): offer keep/remove. */
  stored: boolean;
  placeholder: string;
  keepPlaceholder: string;
  removeLabel: string;
  disabled?: boolean;
  testId?: string;
}

export function SecretInput({
  value,
  onChange,
  stored,
  placeholder,
  keepPlaceholder,
  removeLabel,
  disabled,
  testId,
}: SecretInputProps) {
  const secret = asSecret(value);
  return (
    <div className="space-y-1.5">
      <Input
        type="password"
        // new-password: browsers must neither autofill a saved password here nor offer to save this one.
        autoComplete="new-password"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        value={secret.value}
        disabled={disabled || secret.clear}
        placeholder={stored ? keepPlaceholder : placeholder}
        onChange={(event) => onChange({ value: event.target.value, clear: false })}
        data-testid={testId}
      />
      {stored && (
        <Checkbox
          checked={secret.clear}
          disabled={disabled}
          onChange={(event) => onChange({ value: '', clear: event.target.checked })}
          label={<span className="text-xs">{removeLabel}</span>}
        />
      )}
    </div>
  );
}

// ─── Approval policy ─────────────────────────────────────

export type VaultPolicy = 'ask' | 'auto';

export function PolicyChoice({
  value,
  onChange,
  disabled,
}: {
  value: unknown;
  onChange: (value: VaultPolicy) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const current: VaultPolicy = value === 'auto' ? 'auto' : 'ask';
  const options: Array<{ key: VaultPolicy; title: string; description: string }> = [
    { key: 'ask', title: t('botsVault.policyAsk'), description: t('botsVault.policyAskDesc') },
    { key: 'auto', title: t('botsVault.policyAuto'), description: t('botsVault.policyAutoDesc') },
  ];
  return (
    <div className="grid gap-2 sm:grid-cols-2" role="group">
      {options.map((option) => {
        const selected = current === option.key;
        return (
          <button
            key={option.key}
            type="button"
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => onChange(option.key)}
            data-testid={`vault-policy-${option.key}`}
            className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${
              selected
                ? 'border-primary-edge bg-primary-subtle'
                : 'border-edge bg-surface-raised hover:bg-surface-sunken'
            }`}
          >
            <span className={`block text-sm font-medium ${selected ? 'text-primary-fg-strong' : 'text-fg-secondary'}`}>
              {option.title}
            </span>
            <span className="mt-0.5 block text-[11px] leading-4 text-fg-muted">{option.description}</span>
          </button>
        );
      })}
    </div>
  );
}
