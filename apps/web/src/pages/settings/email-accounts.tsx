/**
 * Email Accounts panel — IMAP/SMTP integrations, on @greenhouse/crud (cards).
 *
 * The card grid, the add Dialog, delete-confirm, empty state and toolbar all
 * come from `defineCrud` with `variant: 'cards'`. Per-card "Test connection"
 * keeps its own spinner (AccountCard); super users get a "show all" scope toggle.
 * Each user can bind up to 10 accounts; there is no edit (add + delete + test).
 */

import React, { useMemo, useState } from 'react';
import { defineCrud, CrudPage, type CrudDataSource, type CrudActionContext } from '@greenhouse/crud';
import { CheckCircle, Trash2, Mail } from '../../lib/icons';
import { Button, Spinner, Toggle, Tag, StatusDot, toast } from '../../components/ui';
import { fetchEmailAccounts, addImapEmailAccount, deleteEmailAccount, testEmailAccount } from '../../lib/api';
import type { EmailAccountInfo } from '../../lib/api';
import { useAuthStore } from '../../stores';

// The add form's inputs (SMTP/IMAP host, port, credentials) aren't columns on
// the row, so widen the row type so those field keys type-check.
type ImapDraft = {
  smtp_host: string;
  smtp_port: number;
  imap_host: string;
  imap_port: number;
  username: string;
  password: string;
  use_tls: boolean;
};
type EmailRow = EmailAccountInfo & Partial<ImapDraft>;

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: 'text-success' },
  disabled: { label: 'Disabled', color: 'text-fg-faint' },
  auth_expired: { label: 'Re-auth needed', color: 'text-warning' },
  error: { label: 'Error', color: 'text-danger' },
};

function statusDotColor(status: string) {
  return status === 'active'
    ? 'success'
    : status === 'auth_expired'
      ? 'warning'
      : status === 'error'
        ? 'danger'
        : 'muted';
}

/** One account card, with its own Test-connection spinner state. */
function AccountCard({
  row,
  ctx,
  showAll,
  reload,
}: {
  row: EmailRow;
  ctx: CrudActionContext;
  showAll: boolean;
  reload: () => void;
}) {
  const [testing, setTesting] = useState(false);
  const status = STATUS_MAP[row.status] ?? STATUS_MAP.error;

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await testEmailAccount(row.id);
      toast(
        result.ok ? 'Connection test passed' : `Connection test failed: ${result.error}`,
        result.ok ? 'success' : 'error',
      );
      reload();
    } catch {
      toast('Connection test failed', 'error');
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="bg-surface-raised border border-edge rounded-lg p-4 h-full flex flex-col justify-between gap-3">
      <div className="flex items-start gap-2.5 min-w-0">
        <StatusDot color={statusDotColor(row.status)} className="mt-1" />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fg truncate" title={row.email_address}>
              {row.email_address}
            </span>
            {showAll && (
              <Tag tone="neutral" className="flex-shrink-0">
                {row.user_id.slice(0, 8)}
              </Tag>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 flex-wrap">
            {row.display_name && <span className="text-[11px] text-fg-muted">{row.display_name}</span>}
            <span className={`text-[10px] ${status.color}`}>{status.label}</span>
            {row.error_message && (
              <span className="text-[10px] text-danger truncate max-w-[200px]" title={row.error_message}>
                {row.error_message}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center justify-end gap-1">
        <Button variant="ghost" size="sm" onClick={handleTest} disabled={testing} title="Test connection">
          {testing ? <Spinner className="h-3.5 w-3.5" /> : <CheckCircle size={13} />}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-danger hover:text-danger"
          onClick={() => ctx.openDelete(row as unknown as Record<string, unknown>)}
          title="Remove account"
        >
          <Trash2 size={13} />
        </Button>
      </div>
    </div>
  );
}

export function EmailAccountsPanel() {
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';
  const [showAll, setShowAll] = useState(false);

  const dataSource = useMemo<CrudDataSource<EmailRow>>(
    () => ({
      async list() {
        const items = await fetchEmailAccounts(showAll);
        return { items, total: items.length };
      },
      async get(id) {
        const found = (await fetchEmailAccounts(showAll)).find((a) => String(a.id) === id);
        if (!found) throw new Error('Account not found');
        return found;
      },
      async create(data) {
        const result = await addImapEmailAccount({
          email_address: String(data.email_address),
          display_name: (data.display_name as string) || undefined,
          smtp_host: String(data.smtp_host ?? ''),
          smtp_port: Number(data.smtp_port) || 465,
          imap_host: (data.imap_host as string) || undefined,
          imap_port: Number(data.imap_port) || 993,
          username: String(data.username ?? ''),
          password: String(data.password ?? ''),
          use_tls: Boolean(data.use_tls),
        });
        if (!result.ok) throw new Error(result.error || 'Failed to add account');
        return result.account;
      },
      remove: (id) => deleteEmailAccount(Number(id)),
    }),
    [showAll],
  );

  const schema = useMemo(
    () =>
      defineCrud<EmailRow>({
        name: 'Email account',
        icon: Mail,
        idField: 'id',
        dataSource,
        variant: 'cards',
        emptyMessage: 'No email accounts connected',
        formMode: 'dialog',
        formTitle: () => 'Create email account',
        columns: [
          { key: 'email_address', label: 'Email' },
          { key: 'display_name', label: 'Display name' },
          {
            key: 'status',
            label: 'Status',
            type: 'badge',
            badgeMap: { active: 'success', disabled: 'secondary', auth_expired: 'warning', error: 'destructive' },
          },
        ],
        formFields: [
          {
            key: 'email_address',
            label: 'Email Address',
            type: 'email',
            width: 2,
            required: true,
            placeholder: 'user@example.com',
          },
          { key: 'display_name', label: 'Display Name', type: 'text', width: 2, placeholder: 'John Doe' },
          {
            key: 'smtp_host',
            label: 'SMTP Host',
            type: 'text',
            width: 2,
            required: true,
            placeholder: 'smtp.example.com',
          },
          { key: 'smtp_port', label: 'SMTP Port', type: 'number', width: 2, defaultValue: 465 },
          { key: 'imap_host', label: 'IMAP Host', type: 'text', width: 2, placeholder: 'imap.example.com (optional)' },
          { key: 'imap_port', label: 'IMAP Port', type: 'number', width: 2, defaultValue: 993 },
          {
            key: 'username',
            label: 'Username',
            type: 'text',
            width: 2,
            required: true,
            placeholder: 'user@example.com',
          },
          {
            key: 'password',
            label: 'Password / App Password',
            type: 'password',
            width: 2,
            required: true,
            placeholder: '••••••••',
          },
          { key: 'use_tls', label: 'Use TLS', type: 'switch', defaultValue: true },
        ],
        access: { canAdd: true, canEdit: false, canDelete: true },
        slots: {
          renderCard: (row, ctx) => <AccountCard row={row} ctx={ctx} showAll={showAll} reload={ctx.reload} />,
        },
      }),
    [dataSource, showAll],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-fg-muted">IMAP/SMTP accounts for a unified inbox and Agent access.</p>
        {isSuper && (
          <label className="flex items-center gap-1.5 text-xs text-fg-muted">
            <Toggle checked={showAll} onChange={() => setShowAll((v) => !v)} />
            Show all users
          </label>
        )}
      </div>
      <CrudPage key={String(showAll)} schema={schema} />
    </div>
  );
}
