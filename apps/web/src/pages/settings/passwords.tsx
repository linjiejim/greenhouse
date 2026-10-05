/**
 * Settings → Passwords — logins the member's Bots may fill into web pages
 * without ever seeing them (spec §8).
 *
 * Write-only by design: the API returns metadata (label, sites, a masked
 * username hint, which secrets exist) and never a stored value, so editing
 * means "leave blank to keep" or an explicit remove. The server decrypts only
 * at the moment it fills a page whose real origin matches one of the sites.
 *
 * Two views over one ModulePage:
 * - Saved logins — @greenhouse/crud schema (table, add/edit dialog, delete
 *   confirm); "always allowed on" grants can be withdrawn inline.
 * - Access log — every fill attempt (which login, which Bot, which site,
 *   outcome and how it was approved), metadata only.
 *
 * When the server has no encryption key the vault cannot store anything; the
 * page says so instead of offering a form that would fail.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { VaultAccessView, VaultErrorCode, VaultItemView, VaultItemWrite } from '@greenhouse/types/bots';
import { ModulePage } from '../../components/app/module-page';
import { Button, EmptyState, IconButton, Input, Tabs, Tag, TagList, toast } from '../../components/ui';
import { History, Lock, Plus, ShieldCheck, X } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate, timeAgo } from '../../lib/utils';
import { useAuthStore } from '../../stores/auth-store';
import {
  allBotsOf,
  copyForCode,
  createVaultItem,
  deleteVaultItem,
  fetchVault,
  fetchVaultLog,
  isBotsApiError,
  listBots,
  setVaultAlwaysOrigins,
  updateVaultItem,
} from '../../lib/api/bots';
import {
  EMPTY_SECRET,
  PolicyChoice,
  SecretInput,
  SitesField,
  VAULT_LABEL_MAX,
  VAULT_MAX_SITES,
  asSecret,
  normalizeTotpSecret,
  parseSiteLines,
  secretWrite,
  type SecretValue,
  type VaultPolicy,
} from '../../components/bots/vault-fields';
import { CrudPage, defineCrud, type CrudDataSource } from './crud';

/** The dialog edits a flat draft; username/password/totp are write-only and start blank. */
interface VaultDraft extends Record<string, unknown> {
  id: string;
  label: string;
  sites: string;
  username: string;
  password: SecretValue;
  totp: SecretValue;
  policy: VaultPolicy;
  origins: string[];
  username_hint: string;
  has_password: boolean;
  has_totp: boolean;
  always_origins: string[];
  last_used_at: string | null;
}

function toDraft(item: VaultItemView): VaultDraft {
  return {
    id: item.id,
    label: item.label,
    sites: item.origins.join('\n'),
    username: '',
    password: EMPTY_SECRET,
    totp: EMPTY_SECRET,
    policy: item.policy,
    origins: item.origins,
    username_hint: item.username_hint,
    has_password: item.has_password,
    has_totp: item.has_totp,
    always_origins: item.always_origins,
    last_used_at: item.last_used_at,
  };
}

// Every VaultError code from /api/bots/vault (`satisfies` keeps the map
// complete); a code a newer server adds falls back to its English message.
const SERVER_ERRORS: Partial<Record<VaultErrorCode, TranslationKey>> = {
  origin_invalid: 'botsVault.err_originInvalid',
  origin_forbidden: 'botsVault.err_originForbidden',
  label_invalid: 'botsVault.err_labelInvalid',
  totp_invalid: 'botsVault.err_totpInvalid',
  vault_unavailable: 'botsVault.unavailableTitle',
  not_found: 'botsVault.err_notFound',
  invalid: 'botsVault.saveFailed',
} satisfies Record<VaultErrorCode, TranslationKey>;

type Translate = ReturnType<typeof useT>;

function friendlyError(t: Translate, err: unknown): Error {
  const key = copyForCode(SERVER_ERRORS, isBotsApiError(err) ? err.code : null);
  if (key) return new Error(t(key));
  return err instanceof Error ? err : new Error(t('botsVault.saveFailed'));
}

/** Form → VaultItemWrite. Blank write-only fields are omitted so the stored values stay. */
export function draftToWrite(input: Partial<VaultDraft>, mode: 'add' | 'edit'): VaultItemWrite {
  const write: VaultItemWrite = {
    label: String(input.label ?? '').trim(),
    origins: parseSiteLines(String(input.sites ?? '')).origins,
    policy: input.policy === 'auto' ? 'auto' : 'ask',
  };
  const username = String(input.username ?? '').trim();
  if (username) write.username = username;
  const password = secretWrite(asSecret(input.password));
  if (password !== undefined && !(mode === 'add' && password === '')) write.password = password;
  const totp = secretWrite(asSecret(input.totp), normalizeTotpSecret);
  if (totp !== undefined && !(mode === 'add' && totp === '')) write.totp = totp;
  return write;
}

export function PasswordsPanel() {
  const t = useT();
  const isSuper = useAuthStore((s) => s.currentUser?.role === 'super');
  const [tab, setTab] = useState<'logins' | 'log'>('logins');
  const [available, setAvailable] = useState(true);
  const markUnavailable = useCallback(() => setAvailable(false), []);

  const notice = (
    <p className="flex items-start gap-2 text-xs leading-5 text-fg-muted">
      <ShieldCheck size={14} className="mt-0.5 flex-shrink-0 text-primary-fg" aria-hidden="true" />
      <span>{t('botsVault.notice')}</span>
    </p>
  );

  if (!available) {
    return (
      <ModulePage moduleId="settings.passwords" layout="list" notice={notice}>
        <EmptyState
          variant="section"
          tone="neutral"
          icon={Lock}
          title={t('botsVault.unavailableTitle')}
          description={isSuper ? t('botsVault.unavailableSuperDesc') : t('botsVault.unavailableDesc')}
        />
      </ModulePage>
    );
  }

  return (
    <ModulePage
      moduleId="settings.passwords"
      layout="list"
      notice={notice}
      tabs={
        <Tabs
          ariaLabel={t('botsVault.tabsLabel')}
          active={tab}
          onChange={(key) => setTab(key === 'log' ? 'log' : 'logins')}
          tabs={[
            { key: 'logins', label: t('botsVault.tabLogins') },
            { key: 'log', label: t('botsVault.tabLog') },
          ]}
        />
      }
    >
      {tab === 'logins' ? <VaultItems onUnavailable={markUnavailable} /> : <VaultAccessLog />}
    </ModulePage>
  );
}

// ─── Saved logins ────────────────────────────────────────

function VaultItems({ onUnavailable }: { onUnavailable: () => void }) {
  const t = useT();
  // Withdrawn "always allow" grants, applied over the last list until the next reload.
  const [revoked, setRevoked] = useState<Record<string, string[]>>({});

  const revoke = useCallback(
    async (row: VaultDraft, origin: string) => {
      const remaining = row.always_origins.filter((o) => o !== origin && !(revoked[row.id] ?? []).includes(o));
      try {
        await setVaultAlwaysOrigins(row.id, remaining);
        setRevoked((prev) => ({ ...prev, [row.id]: [...(prev[row.id] ?? []), origin] }));
        toast(t('botsVault.revoked', { site: origin }), 'success');
      } catch {
        toast(t('botsVault.revokeFailed'), 'error');
      }
    },
    [revoked, t],
  );

  const dataSource = useMemo<CrudDataSource<VaultDraft>>(
    () => ({
      async list(params) {
        const { items, available } = await fetchVault();
        if (!available) onUnavailable();
        setRevoked({});
        const skip = params.skip ?? 0;
        return { items: items.slice(skip, skip + (params.limit ?? 50)).map(toDraft), total: items.length };
      },
      async create(input) {
        try {
          return toDraft(await createVaultItem(draftToWrite(input as Partial<VaultDraft>, 'add')));
        } catch (err) {
          throw friendlyError(t, err);
        }
      },
      async update(id, input) {
        try {
          return toDraft(await updateVaultItem(id, draftToWrite(input as Partial<VaultDraft>, 'edit')));
        } catch (err) {
          throw friendlyError(t, err);
        }
      },
      async remove(id) {
        await deleteVaultItem(id);
      },
    }),
    [onUnavailable, t],
  );

  const schema = useMemo(
    () =>
      defineCrud<VaultDraft>({
        name: t('botsVault.entity'),
        testId: 'vault',
        dataSource,
        idField: 'id',
        icon: Lock,
        formTitle: (mode, row) =>
          mode === 'add' ? t('botsVault.addTitle') : t('botsVault.editTitle', { label: row?.label ?? '' }),
        columns: [
          {
            key: 'label',
            label: t('botsVault.col_login'),
            type: 'custom',
            render: (row) => (
              <div className="min-w-0 max-w-[260px]">
                <p className="truncate text-sm font-medium text-fg" title={row.label}>
                  {row.label}
                </p>
                <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-1">
                  <span className="truncate font-mono text-[11px] text-fg-muted" title={row.username_hint}>
                    {row.username_hint || t('botsVault.usernameNone')}
                  </span>
                  {/* Which secrets exist — never their values. */}
                  {row.has_password && <Tag>{t('botsVault.secretPassword')}</Tag>}
                  {row.has_totp && <Tag tone="info">{t('botsVault.secretTotp')}</Tag>}
                </div>
                {/* Phones hide the Policy and "Always allowed" columns; what lets a
                    Bot fill without asking must stay visible — and revocable — there too. */}
                <div className="mt-1 space-y-1 md:hidden" data-testid="vault-row-mobile-access">
                  {row.policy === 'auto' && <Tag tone="warning">{t('botsVault.policyAuto')}</Tag>}
                  <AlwaysAllowedChips
                    row={row}
                    revoked={revoked}
                    onRevoke={revoke}
                    prefix={<span className="text-[10px] text-fg-faint">{t('botsVault.col_always')}</span>}
                  />
                </div>
              </div>
            ),
          },
          {
            key: 'origins',
            label: t('botsVault.col_sites'),
            type: 'custom',
            render: (row) => <TagList items={row.origins} max={2} />,
          },
          {
            key: 'policy',
            label: t('botsVault.col_policy'),
            type: 'custom',
            responsiveHide: 'md',
            render: (row) => (
              <Tag tone={row.policy === 'auto' ? 'warning' : 'neutral'}>
                {row.policy === 'auto' ? t('botsVault.policyAuto') : t('botsVault.policyAsk')}
              </Tag>
            ),
          },
          {
            key: 'always_origins',
            label: t('botsVault.col_always'),
            type: 'custom',
            responsiveHide: 'md',
            render: (row) => (
              <AlwaysAllowedChips
                row={row}
                revoked={revoked}
                onRevoke={revoke}
                empty={<span className="text-xs text-fg-faint">—</span>}
              />
            ),
          },
          {
            key: 'last_used_at',
            label: t('botsVault.col_lastUsed'),
            type: 'custom',
            responsiveHide: 'lg',
            render: (row) => (
              <span className="whitespace-nowrap text-xs text-fg-muted">
                {row.last_used_at ? timeAgo(row.last_used_at) : t('botsVault.never')}
              </span>
            ),
          },
        ],
        formFields: [
          {
            key: 'label',
            label: t('botsVault.field_label'),
            type: 'text',
            required: true,
            maxLength: VAULT_LABEL_MAX,
            placeholder: t('botsVault.field_labelPlaceholder'),
          },
          {
            key: 'sites',
            label: t('botsVault.field_sites'),
            type: 'custom',
            required: true,
            help: t('botsVault.field_sitesHelp'),
            render: ({ value, onChange, disabled }) => (
              <SitesField
                value={value}
                onChange={onChange}
                disabled={disabled}
                placeholder={'https://github.com\n*.example.com'}
              />
            ),
            rules: [
              {
                validate: (value) => {
                  const { origins, invalid } = parseSiteLines(String(value ?? ''));
                  if (invalid.length > 0) {
                    return t('botsVault.err_siteInvalid', { line: invalid[0]!.line, value: invalid[0]!.value });
                  }
                  if (origins.length === 0) return t('botsVault.err_sitesRequired');
                  if (origins.length > VAULT_MAX_SITES)
                    return t('botsVault.err_tooManySites', { max: VAULT_MAX_SITES });
                  return null;
                },
              },
            ],
          },
          { type: 'divider', label: t('botsVault.secretsDivider') },
          {
            key: 'username',
            label: t('botsVault.field_username'),
            type: 'custom',
            render: ({ value, onChange, form, mode, disabled }) => (
              <UsernameInput
                value={String(value ?? '')}
                onChange={onChange}
                hint={mode === 'edit' ? String(form.username_hint ?? '') : ''}
                disabled={disabled}
              />
            ),
          },
          {
            key: 'password',
            label: t('botsVault.field_password'),
            type: 'custom',
            defaultValue: EMPTY_SECRET,
            render: ({ value, onChange, form, mode, disabled }) => (
              <SecretInput
                value={value}
                onChange={onChange}
                stored={mode === 'edit' && form.has_password === true}
                placeholder="••••••••"
                keepPlaceholder={t('botsVault.field_passwordKeep')}
                removeLabel={t('botsVault.field_passwordRemove')}
                disabled={disabled}
                testId="vault-field-password"
              />
            ),
            rules: [{ validate: (_value, form) => (hasAnySecret(form) ? null : t('botsVault.err_secretRequired')) }],
          },
          {
            key: 'totp',
            label: t('botsVault.field_totp'),
            type: 'custom',
            defaultValue: EMPTY_SECRET,
            help: t('botsVault.field_totpHelp'),
            render: ({ value, onChange, form, mode, disabled }) => (
              <SecretInput
                value={value}
                onChange={onChange}
                stored={mode === 'edit' && form.has_totp === true}
                placeholder={t('botsVault.field_totpPlaceholder')}
                keepPlaceholder={t('botsVault.field_totpKeep')}
                removeLabel={t('botsVault.field_totpRemove')}
                disabled={disabled}
                testId="vault-field-totp"
              />
            ),
            rules: [
              {
                validate: (value) => {
                  const secret = asSecret(value);
                  if (secret.clear || !secret.value) return null;
                  return normalizeTotpSecret(secret.value) ? null : t('botsVault.err_totpInvalid');
                },
              },
            ],
          },
          {
            key: 'policy',
            label: t('botsVault.field_policy'),
            type: 'custom',
            defaultValue: 'ask',
            render: ({ value, onChange, disabled }) => (
              <PolicyChoice value={value} onChange={onChange} disabled={disabled} />
            ),
          },
        ],
        access: { canView: false, canAdd: true, canEdit: true, canDelete: true },
        onRowClick: 'edit',
        deleteConfirm: (row) => ({
          title: t('botsVault.deleteTitle', { label: row.label }),
          description: t('botsVault.deleteDesc'),
        }),
        slots: {
          toolbar: (ctx) => (
            <div className="flex items-center gap-3">
              <span className="text-xs text-fg-muted">{t('botsVault.count', { count: ctx.total })}</span>
              <div className="flex-1" />
              <Button size="sm" onClick={ctx.openCreate} data-testid="vault-add">
                <Plus size={14} className="mr-1" />
                {t('botsVault.add')}
              </Button>
            </div>
          ),
          empty: <EmptyState icon={Lock} title={t('botsVault.emptyTitle')} description={t('botsVault.emptyDesc')} />,
        },
      }),
    [t, dataSource, revoke, revoked],
  );

  return <CrudPage schema={schema} />;
}

/**
 * "Always allowed on" grants of one login, each withdrawable in place. The ✕
 * stops propagation: the row itself opens the edit dialog.
 */
function AlwaysAllowedChips({
  row,
  revoked,
  onRevoke,
  prefix,
  empty = null,
}: {
  row: VaultDraft;
  revoked: Record<string, string[]>;
  onRevoke: (row: VaultDraft, origin: string) => Promise<void>;
  prefix?: React.ReactNode;
  empty?: React.ReactNode;
}) {
  const t = useT();
  const sites = row.always_origins.filter((o) => !(revoked[row.id] ?? []).includes(o));
  if (sites.length === 0) return <>{empty}</>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      {prefix}
      {sites.map((site) => (
        <span
          key={site}
          className="inline-flex max-w-[200px] items-center gap-0.5 rounded border border-edge bg-surface-muted py-0.5 pl-1.5 pr-0.5 text-[10px] text-fg-muted"
        >
          <span className="truncate" title={site}>
            {site}
          </span>
          <IconButton
            label={t('botsVault.revoke', { site })}
            variant="destructive"
            size="compact"
            tooltip="top"
            tooltipMode="portal"
            className="!h-4 !w-4"
            onClick={(event) => {
              event.stopPropagation();
              void onRevoke(row, site);
            }}
          >
            <X size={10} />
          </IconButton>
        </span>
      ))}
    </div>
  );
}

/** After the edit: does the item still hold a password or a 2FA secret? */
function hasAnySecret(form: Record<string, unknown>): boolean {
  const password = asSecret(form.password);
  const totp = asSecret(form.totp);
  const keepsPassword = form.has_password === true && !password.clear;
  const keepsTotp = form.has_totp === true && !totp.clear;
  return Boolean(password.value) || Boolean(totp.value) || keepsPassword || keepsTotp;
}

/** The username is not secret, but it is write-only too: blank keeps the stored one. */
function UsernameInput({
  value,
  onChange,
  hint,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  hint: string;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <Input
      value={value}
      disabled={disabled}
      placeholder={hint ? t('botsVault.field_usernameKeep', { hint }) : t('botsVault.field_usernamePlaceholder')}
      autoComplete="off"
      spellCheck={false}
      onChange={(event) => onChange(event.target.value)}
      data-testid="vault-field-username"
    />
  );
}

// ─── Access log ──────────────────────────────────────────

const ACTION_KEYS: Record<VaultAccessView['action'], TranslationKey> = {
  fill_login: 'botsVault.action_fill_login',
  fill_totp: 'botsVault.action_fill_totp',
  secure_login: 'botsVault.action_secure_login',
};

const OUTCOME_COPY: Record<
  VaultAccessView['outcome'],
  { key: TranslationKey; tone: 'success' | 'neutral' | 'danger' }
> = {
  filled: { key: 'botsVault.outcome_filled', tone: 'success' },
  denied: { key: 'botsVault.outcome_denied', tone: 'neutral' },
  origin_mismatch: { key: 'botsVault.outcome_origin_mismatch', tone: 'danger' },
  failed: { key: 'botsVault.outcome_failed', tone: 'danger' },
};

const APPROVAL_KEYS: Record<NonNullable<VaultAccessView['approval']>, TranslationKey> = {
  auto: 'botsVault.approval_auto',
  once: 'botsVault.approval_once',
  always: 'botsVault.approval_always',
  user: 'botsVault.approval_user',
};

type LogRow = VaultAccessView & Record<string, unknown>;

function VaultAccessLog() {
  const t = useT();
  const [botNames, setBotNames] = useState<Record<string, string>>({});

  useEffect(() => {
    // Archived Bots too: the log outlives them, and "Sage (archived)" says more than a blank.
    listBots()
      .then((overview) =>
        setBotNames(
          Object.fromEntries(
            allBotsOf(overview).map((bot) => [
              bot.id,
              bot.status === 'active' ? bot.name : t('bots.archivedName', { name: bot.name }),
            ]),
          ),
        ),
      )
      .catch(() => setBotNames({}));
  }, [t]);

  const dataSource = useMemo<CrudDataSource<LogRow>>(
    () => ({
      async list(params) {
        const entries = await fetchVaultLog();
        const skip = params.skip ?? 0;
        return { items: entries.slice(skip, skip + (params.limit ?? 50)) as LogRow[], total: entries.length };
      },
    }),
    [],
  );

  const schema = useMemo(
    () =>
      defineCrud<LogRow>({
        name: t('botsVault.logEntity'),
        testId: 'vault-log',
        dataSource,
        idField: 'id',
        icon: History,
        columns: [
          {
            key: 'created_at',
            label: t('botsVault.col_time'),
            type: 'custom',
            render: (row) => (
              <span className="whitespace-nowrap text-xs text-fg-muted">{formatDate(row.created_at)}</span>
            ),
          },
          { key: 'item_label', label: t('botsVault.col_item'), type: 'text', truncate: 40 },
          {
            key: 'bot_id',
            label: t('botsVault.col_bot'),
            type: 'custom',
            render: (row) => (
              <span className="text-xs text-fg-secondary">
                {row.bot_id ? (botNames[row.bot_id] ?? t('botsVault.deletedBot')) : '—'}
              </span>
            ),
          },
          {
            key: 'origin',
            label: t('botsVault.col_site'),
            type: 'custom',
            responsiveHide: 'sm',
            render: (row) => (
              <span className="block max-w-[220px] truncate font-mono text-[11px] text-fg-muted" title={row.origin}>
                {row.origin}
              </span>
            ),
          },
          {
            key: 'action',
            label: t('botsVault.col_action'),
            type: 'custom',
            responsiveHide: 'md',
            render: (row) => <span className="text-xs text-fg-secondary">{t(ACTION_KEYS[row.action])}</span>,
          },
          {
            key: 'outcome',
            label: t('botsVault.col_outcome'),
            type: 'custom',
            render: (row) => {
              const copy = OUTCOME_COPY[row.outcome];
              return copy ? <Tag tone={copy.tone}>{t(copy.key)}</Tag> : <span className="text-xs">{row.outcome}</span>;
            },
          },
          {
            key: 'approval',
            label: t('botsVault.col_approval'),
            type: 'custom',
            responsiveHide: 'lg',
            render: (row) => (
              <span className="text-xs text-fg-muted">{row.approval ? t(APPROVAL_KEYS[row.approval]) : '—'}</span>
            ),
          },
        ],
        slots: {
          empty: (
            <EmptyState
              icon={History}
              tone="neutral"
              title={t('botsVault.logEmptyTitle')}
              description={t('botsVault.logEmptyDesc')}
            />
          ),
        },
      }),
    [t, dataSource, botNames],
  );

  return <CrudPage schema={schema} />;
}
