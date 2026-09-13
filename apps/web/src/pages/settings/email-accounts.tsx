/**
 * Email Accounts panel — bind a personal IMAP/SMTP mailbox.
 *
 * One @greenhouse/crud schema drives the table, the add/edit dialog and the delete
 * confirmation. The bespoke part is the connection block: picking a provider
 * fills in host/port/TLS AND unfolds that provider's own instructions, because
 * "where do I get the password" is the actual hard step — every one of these
 * providers wants a generated app password rather than the login password, and
 * each hides that switch somewhere different.
 *
 * The whole connection is ONE custom field holding an object (same shape as the
 * cron builder in automations.tsx): a preset choice rewrites five sibling
 * values at once, and a `type: 'custom'` field can only write its own. The data
 * source unpacks it on the way out.
 *
 * The server tests IMAP *and* SMTP before it saves, so a row in this table is a
 * mailbox that demonstrably worked at least once.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { ModulePage } from '../../components/app/module-page';
import { EMAIL_PRESETS, getEmailPreset, type EmailPresetId, type EmailAccountView } from '@greenhouse/types/email';
import { defineCrud, CrudPage, type CrudDataSource, type CrudFieldRenderProps } from './crud';
import { Button, EmptyState, Input, Select, Tag, toast } from '../../components/ui';
import { CheckCircle, ExternalLink, Mail, Plus, RefreshCw } from '../../lib/icons';
import * as api from '../../lib/api';
import { formatDate } from '../../lib/utils';
import { useT, type TranslationKey } from '../../lib/i18n';

interface ConnectionValue {
  preset: EmailPresetId;
  imap_host: string;
  imap_port: number;
  smtp_host: string;
  smtp_port: number;
  use_tls: boolean;
}

/** The dialog edits a flat draft; `password` is write-only and never read back. */
interface AccountDraft extends Record<string, unknown> {
  id: number;
  email_address: string;
  display_name: string | null;
  username: string;
  password: string;
  connection: ConnectionValue;
  status: EmailAccountView['status'];
  last_verified_at: string | null;
  error_message: string | null;
  preset: EmailPresetId;
}

function toDraft(row: EmailAccountView): AccountDraft {
  return {
    id: row.id,
    email_address: row.email_address,
    display_name: row.display_name,
    username: row.username,
    password: '',
    connection: {
      preset: row.preset,
      imap_host: row.imap_host,
      imap_port: row.imap_port,
      smtp_host: row.smtp_host,
      smtp_port: row.smtp_port,
      use_tls: row.use_tls,
    },
    status: row.status,
    last_verified_at: row.last_verified_at,
    error_message: row.error_message,
    preset: row.preset,
  };
}

const FEISHU = getEmailPreset('feishu')!;

const DEFAULT_CONNECTION: ConnectionValue = {
  preset: 'feishu',
  imap_host: FEISHU.imap_host,
  imap_port: FEISHU.imap_port,
  smtp_host: FEISHU.smtp_host,
  smtp_port: FEISHU.smtp_port,
  use_tls: FEISHU.use_tls,
};

// ─── Connection field ────────────────────────────────────

function ConnectionField({ value, onChange, disabled }: CrudFieldRenderProps) {
  const t = useT();
  const conn = (value as ConnectionValue | undefined) ?? DEFAULT_CONNECTION;
  const preset = getEmailPreset(conn.preset);
  const patch = (next: Partial<ConnectionValue>) => onChange({ ...conn, ...next });

  // Each provider's steps are one i18n string, newline-separated, rendered as
  // an ordered list — the numbering is presentation, not content.
  // help_key is data (the preset table), so the key type is asserted here.
  const steps = String(t((preset?.help_key ?? 'emailAccounts.help.custom') as TranslationKey)).split('\n');

  return (
    <div className="space-y-3">
      <Select
        value={conn.preset}
        disabled={disabled}
        onChange={(e) => {
          const next = getEmailPreset(e.target.value);
          if (!next) return;
          patch({
            preset: next.id,
            imap_host: next.imap_host,
            imap_port: next.imap_port,
            smtp_host: next.smtp_host,
            smtp_port: next.smtp_port,
            use_tls: next.use_tls,
          });
        }}
      >
        {EMAIL_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </Select>

      <div className="rounded-lg border border-edge bg-surface-muted p-3">
        <p className="text-xs font-medium text-fg-secondary mb-1.5">{t('emailAccounts.help.title')}</p>
        <ol className="text-xs text-fg-muted space-y-1 list-decimal list-inside">
          {steps.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
        {preset?.help_url && (
          <a
            href={preset.help_url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-2 inline-flex items-center gap-1 text-xs text-primary-fg hover:underline"
          >
            {t('emailAccounts.help.open')}
            <ExternalLink size={11} />
          </a>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-fg-faint mb-1 block">IMAP host</label>
          <Input
            size="sm"
            disabled={disabled}
            value={conn.imap_host}
            onChange={(e) => patch({ imap_host: e.target.value })}
          />
        </div>
        <div>
          <label className="text-[11px] text-fg-faint mb-1 block">IMAP port</label>
          <Input
            size="sm"
            type="number"
            disabled={disabled}
            value={String(conn.imap_port)}
            onChange={(e) => patch({ imap_port: Number(e.target.value) || 0 })}
          />
        </div>
        <div>
          <label className="text-[11px] text-fg-faint mb-1 block">SMTP host</label>
          <Input
            size="sm"
            disabled={disabled}
            value={conn.smtp_host}
            onChange={(e) => patch({ smtp_host: e.target.value })}
          />
        </div>
        <div>
          <label className="text-[11px] text-fg-faint mb-1 block">SMTP port</label>
          <Input
            size="sm"
            type="number"
            disabled={disabled}
            value={String(conn.smtp_port)}
            onChange={(e) => patch({ smtp_port: Number(e.target.value) || 0 })}
          />
        </div>
      </div>
    </div>
  );
}

// ─── Panel ───────────────────────────────────────────────

export function EmailAccountsPanel() {
  const t = useT();
  const [shared, setShared] = useState<{ available: boolean; address: string | null }>({
    available: false,
    address: null,
  });
  const [testingId, setTestingId] = useState<number | null>(null);

  useEffect(() => {
    api
      .fetchSharedMailbox()
      .then((s) => setShared({ available: s.available, address: s.address }))
      .catch(() => setShared({ available: false, address: null }));
  }, []);

  const dataSource = useMemo<CrudDataSource<AccountDraft>>(
    () => ({
      async list() {
        const accounts = await api.fetchEmailAccounts();
        return { items: accounts.map(toDraft), total: accounts.length };
      },
      async create(input) {
        const draft = input as Partial<AccountDraft>;
        const conn = draft.connection ?? DEFAULT_CONNECTION;
        const result = await api.createEmailAccount({
          email_address: String(draft.email_address ?? '').trim(),
          display_name: draft.display_name ? String(draft.display_name) : null,
          preset: conn.preset,
          imap_host: conn.imap_host,
          imap_port: conn.imap_port,
          smtp_host: conn.smtp_host,
          smtp_port: conn.smtp_port,
          use_tls: conn.use_tls,
          username: draft.username ? String(draft.username) : undefined,
          password: String(draft.password ?? ''),
        });
        toast(t('emailAccounts.saved'), 'success');
        return toDraft(result.account);
      },
      async update(id, input) {
        const draft = input as Partial<AccountDraft>;
        const conn = draft.connection;
        const result = await api.updateEmailAccount(Number(id), {
          display_name: draft.display_name ? String(draft.display_name) : null,
          imap_host: conn?.imap_host,
          imap_port: conn?.imap_port,
          smtp_host: conn?.smtp_host,
          smtp_port: conn?.smtp_port,
          use_tls: conn?.use_tls,
          username: draft.username ? String(draft.username) : undefined,
          // Empty means "keep the stored password", not "clear it".
          password: draft.password ? String(draft.password) : undefined,
        });
        toast(t('emailAccounts.saved'), 'success');
        return toDraft(result.account);
      },
      async remove(id) {
        await api.deleteEmailAccount(Number(id));
      },
    }),
    [t],
  );

  const schema = useMemo(
    () =>
      defineCrud<AccountDraft>({
        name: t('emailAccounts.entity'),
        testId: 'email-accounts',
        dataSource,
        idField: 'id',
        icon: Mail,
        columns: [
          { key: 'email_address', label: t('emailAccounts.address'), type: 'text' },
          {
            key: 'preset',
            label: t('emailAccounts.provider'),
            type: 'custom',
            render: (row) => <Tag tone="neutral">{getEmailPreset(row.preset)?.label ?? row.preset}</Tag>,
          },
          {
            key: 'status',
            label: t('emailAccounts.status'),
            type: 'custom',
            render: (row) => (
              <Tag tone={row.status === 'active' ? 'success' : row.status === 'error' ? 'danger' : 'neutral'} truncate>
                {row.status === 'error' && row.error_message ? row.error_message : row.status}
              </Tag>
            ),
          },
          {
            key: 'last_verified_at',
            label: t('emailAccounts.lastVerified'),
            type: 'custom',
            render: (row) => (
              <span className="text-xs text-fg-muted">
                {row.last_verified_at ? formatDate(row.last_verified_at) : '—'}
              </span>
            ),
          },
        ],
        formFields: [
          {
            key: 'connection',
            label: t('emailAccounts.provider'),
            type: 'custom',
            defaultValue: DEFAULT_CONNECTION,
            render: (props) => <ConnectionField {...props} />,
          },
          { type: 'divider', label: t('emailAccounts.credentials') },
          {
            key: 'email_address',
            label: t('emailAccounts.address'),
            type: 'text',
            required: true,
            placeholder: 'you@example.com',
          },
          {
            key: 'password',
            label: t('emailAccounts.password'),
            type: 'custom',
            comment: t('emailAccounts.passwordHint'),
            render: ({ value, onChange, disabled, mode }) => (
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={mode === 'edit' ? t('emailAccounts.passwordKeep') : '••••••••'}
                disabled={disabled}
                value={(value as string) ?? ''}
                onChange={(e) => onChange(e.target.value)}
              />
            ),
          },
          {
            key: 'username',
            label: t('emailAccounts.username'),
            type: 'text',
            comment: t('emailAccounts.usernameHint'),
          },
          {
            key: 'display_name',
            label: t('emailAccounts.displayName'),
            type: 'text',
            comment: t('emailAccounts.displayNameHint'),
          },
        ],
        access: { canView: false, canAdd: true, canEdit: true, canDelete: true },
        deleteConfirm: (row) => ({
          title: t('emailAccounts.unbindTitle'),
          description: t('emailAccounts.unbindConfirm', { address: row.email_address }),
        }),
        tableActions: [
          {
            key: 'test',
            label: t('emailAccounts.test'),
            icon: RefreshCw,
            tone: 'primary',
            onClick: async (row, ctx) => {
              if (testingId === row.id) return;
              setTestingId(row.id);
              try {
                const result = await api.testEmailAccount(row.id);
                const ok = result.test.imap.ok && result.test.smtp.ok;
                toast(
                  ok
                    ? t('emailAccounts.testOk', { address: row.email_address })
                    : `IMAP ${result.test.imap.ok ? 'OK' : '✗'} · SMTP ${result.test.smtp.ok ? 'OK' : '✗'}`,
                  ok ? 'success' : 'error',
                );
                ctx.reload();
              } catch (err) {
                toast(err instanceof Error ? err.message : t('emailAccounts.testFailed'), 'error');
              } finally {
                setTestingId(null);
              }
            },
          },
        ],
        slots: {
          banner: () =>
            shared.available ? (
              <div className="flex items-center gap-2 rounded-lg border border-edge bg-surface-muted px-3 py-2">
                <CheckCircle size={14} className="text-success flex-shrink-0" />
                <span className="text-xs text-fg-muted">
                  {t('emailAccounts.sharedAvailable', { address: shared.address ?? '' })}
                </span>
              </div>
            ) : null,
          toolbar: (ctx) => (
            <div className="flex items-center gap-3">
              <span className="text-xs text-fg-muted">{t('emailAccounts.countLabel', { count: ctx.total })}</span>
              <div className="flex-1" />
              <Button size="sm" onClick={ctx.openCreate}>
                <Plus size={14} className="mr-1" />
                {t('emailAccounts.add')}
              </Button>
            </div>
          ),
          empty: (
            <EmptyState icon={Mail} title={t('emailAccounts.noneTitle')} description={t('emailAccounts.noneDesc')} />
          ),
        },
      }),
    [t, dataSource, testingId, shared],
  );

  return (
    <ModulePage moduleId="settings.email-accounts" layout="list">
      <CrudPage schema={schema} />
    </ModulePage>
  );
}
