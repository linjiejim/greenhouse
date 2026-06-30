/**
 * Email Accounts panel — Settings sub-page for managing email integrations.
 *
 * Each user can bind up to 10 generic IMAP/SMTP email accounts.
 * Super users can see all users' accounts for audit.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { CheckCircle, Trash2, Plus, Inbox, X } from '../../lib/icons';
import {
  Button,
  Input,
  Spinner,
  Toggle,
  Tag,
  EmptyState,
  ListToolbar,
  ConfirmDialog,
  StatusDot,
} from '../../components/ui';
import { toast } from '../../components/ui';
import { fetchEmailAccounts, addImapEmailAccount, deleteEmailAccount, testEmailAccount } from '../../lib/api';
import type { EmailAccountInfo } from '../../lib/api';
import { useAuthStore } from '../../stores';

const STATUS_MAP: Record<string, { label: string; color: string }> = {
  active: { label: 'Active', color: 'text-success' },
  disabled: { label: 'Disabled', color: 'text-fg-faint' },
  auth_expired: { label: 'Re-auth needed', color: 'text-warning' },
  error: { label: 'Error', color: 'text-danger' },
};

export function EmailAccountsPanel() {
  const { currentUser } = useAuthStore();
  const isSuper = currentUser?.role === 'super';

  const [accounts, setAccounts] = useState<EmailAccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [showAddImap, setShowAddImap] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<EmailAccountInfo | null>(null);

  // IMAP/SMTP form
  const [imapForm, setImapForm] = useState({
    email_address: '',
    display_name: '',
    smtp_host: '',
    smtp_port: 465,
    imap_host: '',
    imap_port: 993,
    username: '',
    password: '',
    use_tls: true,
  });
  const [addLoading, setAddLoading] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await fetchEmailAccounts(showAll);
      setAccounts(data);
    } catch {
      toast('Failed to load email accounts', 'error');
    } finally {
      setLoading(false);
    }
  }, [showAll]);

  useEffect(() => {
    load();
  }, [load]);

  const handleTest = async (id: number) => {
    setTestingId(id);
    try {
      const result = await testEmailAccount(id);
      if (result.ok) {
        toast('Connection test passed', 'success');
      } else {
        toast(`Connection test failed: ${result.error}`, 'error');
      }
      await load();
    } catch {
      toast('Connection test failed', 'error');
    } finally {
      setTestingId(null);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    setDeleteTarget(null);
    setDeletingId(id);
    try {
      await deleteEmailAccount(id);
      toast('Account removed', 'success');
      await load();
    } catch {
      toast('Failed to remove account', 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const handleAddImap = async () => {
    if (!imapForm.email_address || !imapForm.smtp_host || !imapForm.username || !imapForm.password) {
      toast('Please fill in all required fields', 'error');
      return;
    }
    setAddLoading(true);
    try {
      const result = await addImapEmailAccount({
        email_address: imapForm.email_address,
        display_name: imapForm.display_name || undefined,
        smtp_host: imapForm.smtp_host,
        smtp_port: imapForm.smtp_port,
        imap_host: imapForm.imap_host || undefined,
        imap_port: imapForm.imap_port,
        username: imapForm.username,
        password: imapForm.password,
        use_tls: imapForm.use_tls,
      });
      if (result.ok) {
        toast('IMAP/SMTP account added', 'success');
        setShowAddImap(false);
        setImapForm({
          email_address: '',
          display_name: '',
          smtp_host: '',
          smtp_port: 465,
          imap_host: '',
          imap_port: 993,
          username: '',
          password: '',
          use_tls: true,
        });
        await load();
      } else {
        toast(result.error || 'Failed to add account', 'error');
      }
    } catch {
      toast('Failed to add account', 'error');
    } finally {
      setAddLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner />
      </div>
    );
  }

  const createButton = (
    <Button size="sm" onClick={() => setShowAddImap((v) => !v)}>
      <Plus size={14} className="mr-1" />
      Create account
    </Button>
  );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <ListToolbar
        hint="IMAP/SMTP accounts for a unified inbox and Agent access."
        count={accounts.length > 0 ? `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'}` : undefined}
        actions={
          <>
            {isSuper && (
              <label className="flex items-center gap-1.5 text-xs text-fg-muted">
                <Toggle checked={showAll} onChange={() => setShowAll(!showAll)} />
                Show all users
              </label>
            )}
            {createButton}
          </>
        }
      />

      {/* Account list */}
      {accounts.length > 0 && (
        <div className="bg-surface-raised border border-edge rounded-xl overflow-hidden">
          <div className="divide-y divide-edge">
            {accounts.map((account) => {
              const status = STATUS_MAP[account.status] ?? STATUS_MAP.error;
              return (
                <div
                  key={account.id}
                  className="px-4 py-3 flex items-center justify-between hover:bg-surface-sunken transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <StatusDot
                      color={
                        account.status === 'active'
                          ? 'success'
                          : account.status === 'auth_expired'
                            ? 'warning'
                            : account.status === 'error'
                              ? 'danger'
                              : 'muted'
                      }
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-fg truncate" title={account.email_address}>
                          {account.email_address}
                        </span>
                        {showAll && (
                          <Tag tone="neutral" className="flex-shrink-0">
                            {account.user_id.slice(0, 8)}
                          </Tag>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-0.5">
                        {account.display_name && (
                          <span className="text-[11px] text-fg-muted">{account.display_name}</span>
                        )}
                        <span className={`text-[10px] ${status.color}`}>{status.label}</span>
                        {account.error_message && (
                          <span
                            className="text-[10px] text-danger truncate max-w-[200px]"
                            title={account.error_message}
                          >
                            {account.error_message}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-1 flex-shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleTest(account.id)}
                      disabled={testingId === account.id}
                      title="Test connection"
                    >
                      {testingId === account.id ? <Spinner className="h-3.5 w-3.5" /> : <CheckCircle size={13} />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeleteTarget(account)}
                      disabled={deletingId === account.id}
                      className="text-danger hover:text-danger"
                      title="Remove account"
                    >
                      {deletingId === account.id ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 size={13} />}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {accounts.length === 0 && (
        <EmptyState
          icon={Inbox}
          title="No email accounts connected"
          description="Connect an IMAP/SMTP account for a unified inbox and Agent access."
          action={createButton}
        />
      )}

      {/* IMAP/SMTP form */}
      {showAddImap && (
        <div className="bg-surface-raised border border-edge rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-fg">Create email account</h4>
            <button onClick={() => setShowAddImap(false)} className="p-1 text-fg-muted hover:text-fg">
              <X size={14} />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-fg-faint mb-1 block">Email Address *</label>
              <Input
                type="email"
                placeholder="user@example.com"
                value={imapForm.email_address}
                onChange={(e) => setImapForm((f) => ({ ...f, email_address: e.target.value }))}
                size="sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-fg-faint mb-1 block">Display Name</label>
              <Input
                placeholder="John Doe"
                value={imapForm.display_name}
                onChange={(e) => setImapForm((f) => ({ ...f, display_name: e.target.value }))}
                size="sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-fg-faint mb-1 block">SMTP Host *</label>
              <Input
                placeholder="smtp.example.com"
                value={imapForm.smtp_host}
                onChange={(e) => setImapForm((f) => ({ ...f, smtp_host: e.target.value }))}
                size="sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-fg-faint mb-1 block">SMTP Port</label>
              <Input
                type="number"
                value={imapForm.smtp_port}
                onChange={(e) => setImapForm((f) => ({ ...f, smtp_port: parseInt(e.target.value) || 465 }))}
                size="sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-fg-faint mb-1 block">IMAP Host</label>
              <Input
                placeholder="imap.example.com (optional)"
                value={imapForm.imap_host}
                onChange={(e) => setImapForm((f) => ({ ...f, imap_host: e.target.value }))}
                size="sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-fg-faint mb-1 block">IMAP Port</label>
              <Input
                type="number"
                value={imapForm.imap_port}
                onChange={(e) => setImapForm((f) => ({ ...f, imap_port: parseInt(e.target.value) || 993 }))}
                size="sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-fg-faint mb-1 block">Username *</label>
              <Input
                placeholder="user@example.com"
                value={imapForm.username}
                onChange={(e) => setImapForm((f) => ({ ...f, username: e.target.value }))}
                size="sm"
              />
            </div>
            <div>
              <label className="text-[11px] text-fg-faint mb-1 block">Password / App Password *</label>
              <Input
                type="password"
                placeholder="••••••••"
                value={imapForm.password}
                onChange={(e) => setImapForm((f) => ({ ...f, password: e.target.value }))}
                size="sm"
              />
            </div>
          </div>
          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-2">
              <Toggle checked={imapForm.use_tls} onChange={() => setImapForm((f) => ({ ...f, use_tls: !f.use_tls }))} />
              <span className="text-xs text-fg-muted">Use TLS</span>
            </div>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setShowAddImap(false)}>
                Cancel
              </Button>
              <Button variant="default" size="sm" onClick={handleAddImap} disabled={addLoading}>
                {addLoading ? <Spinner className="h-3.5 w-3.5" /> : 'Create account'}
              </Button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Remove email account"
        description={`Remove "${deleteTarget?.email_address}"? This disconnects the account but does not delete any mail.`}
        confirmLabel="Remove"
        confirmVariant="destructive"
      />
    </div>
  );
}
