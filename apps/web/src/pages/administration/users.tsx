/**
 * User Management Panel — 用户管理（筛选/排序/删除增强版）
 */

import React, { useState, useEffect, useMemo } from 'react';
import {
  Button,
  Input,
  Select,
  Dialog,
  ConfirmDialog,
  toast,
  SkeletonRow,
  SearchInput,
  Tag,
  IconButton,
  Avatar,
} from '../../components/ui';
import { FormActions, FormError, FormField, FormGrid, FormSection } from '../../components/form';
import { ModulePage } from '../../components/app/module-page';
import { Pencil, Key, Ban, Check, Trash2, ArrowUpDown, Shield, Mail, RefreshCw, XCircle } from '../../lib/icons';
import { authFetch } from '../../lib/auth';
import { formatTokens } from '../../lib/api';
import {
  createManagedUser,
  fetchManagedUsers,
  resendManagedUserPasswordLink,
  resetManagedUserPassword,
  revokeManagedUserPasswordLink,
  type ManagedUser,
  type PasswordLinkCapability,
} from '../../lib/api/admin';
import { useT } from '../../lib/i18n';
import { ROLE_TONE } from '../../lib/utils';
import { UserPermissionsModal, type PermissionModalUser } from './user-permissions-modal';

// ─── Types ───────────────────────────────────────────────

type SortKey = 'default' | 'month_tokens' | 'total_calls' | 'last_login';

function hasFailedDelivery(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('delivery' in value)) return false;
  const delivery = value.delivery;
  return !!delivery && typeof delivery === 'object' && 'status' in delivery && delivery.status === 'failed';
}

// ─── Main Component ──────────────────────────────────────

export function UserManagementPanel() {
  const t = useT();
  const [users, setUsers] = useState<ManagedUser[]>([]);
  const [passwordLinkCapability, setPasswordLinkCapability] = useState<PasswordLinkCapability | null>(null);
  const [loading, setLoading] = useState(true);
  const [editUser, setEditUser] = useState<ManagedUser | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<{
    user: ManagedUser;
    action: string;
    newStatus: string;
  } | null>(null);
  const [resetPwdUser, setResetPwdUser] = useState<ManagedUser | null>(null);
  const [resetPwdValue, setResetPwdValue] = useState('');
  const [resetMode, setResetMode] = useState<'email_link' | 'direct_password'>('email_link');
  const [revokeLinkTarget, setRevokeLinkTarget] = useState<ManagedUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [permUser, setPermUser] = useState<PermissionModalUser | null>(null);

  // ─── Filters & Sort ──────────────────────────────────
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('default');

  const [form, setForm] = useState({
    email: '',
    password: '',
    nickname: '',
    role: 'team' as string,
    monthly_token_limit: 5000000,
    credential_mode: 'email_link' as 'email_link' | 'direct_password',
  });

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await fetchManagedUsers();
      setUsers(data.users);
      const capability = data.password_link_capability;
      setPasswordLinkCapability(capability);
      if (!capability.available) {
        setForm((current) => ({ ...current, credential_mode: 'direct_password' }));
        setResetMode('direct_password');
      }
    } catch (_err) {
      /* ignore */
    }
    setLoading(false);
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const passwordLinkUnavailableText =
    passwordLinkCapability && !passwordLinkCapability.available
      ? passwordLinkCapability.reason === 'shared_mailbox_unconfigured'
        ? t('settings.passwordLinkMissingMailbox')
        : passwordLinkCapability.reason === 'missing_public_base_url'
          ? t('settings.passwordLinkMissingBaseUrl')
          : passwordLinkCapability.reason === 'insecure_public_base_url'
            ? t('settings.passwordLinkInsecureBaseUrl')
            : t('settings.passwordLinkInvalidBaseUrl')
      : '';

  // ─── Filtered & Sorted Users ─────────────────────────
  const filteredUsers = useMemo(() => {
    let result = users;

    // Text search: name or email
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((u) => u.nickname.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
    }

    // Role filter
    if (filterRole) {
      result = result.filter((u) => u.role === filterRole);
    }

    // Status filter
    if (filterStatus) {
      result = result.filter((u) => u.status === filterStatus);
    }

    // Sort
    if (sortKey !== 'default') {
      result = [...result].sort((a, b) => {
        const usageA = a.usage_summary;
        const usageB = b.usage_summary;
        switch (sortKey) {
          case 'month_tokens':
            return (usageB?.month_tokens ?? 0) - (usageA?.month_tokens ?? 0);
          case 'total_calls':
            return (usageB?.total_calls ?? 0) - (usageA?.total_calls ?? 0);
          case 'last_login': {
            const timeA = a.last_login_at ? new Date(a.last_login_at).getTime() : 0;
            const timeB = b.last_login_at ? new Date(b.last_login_at).getTime() : 0;
            return timeB - timeA;
          }
          default:
            return 0;
        }
      });
    }

    return result;
  }, [users, search, filterRole, filterStatus, sortKey]);

  const handleCreate = async () => {
    if (!form.email || !form.nickname || (form.credential_mode === 'direct_password' && !form.password)) {
      setError(t('settings.fillRequiredFields'));
      return;
    }
    if (form.credential_mode === 'direct_password' && form.password.length < 8) {
      setError(t('settings.passwordMinLength'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const data = await createManagedUser({
        email: form.email,
        nickname: form.nickname,
        role: 'team',
        monthly_token_limit: form.monthly_token_limit,
        credential_mode: form.credential_mode,
        ...(form.credential_mode === 'direct_password' ? { password: form.password } : {}),
      });
      setShowCreate(false);
      setForm({
        email: '',
        password: '',
        nickname: '',
        role: 'team',
        monthly_token_limit: 5000000,
        credential_mode: passwordLinkCapability?.available ? 'email_link' : 'direct_password',
      });
      if (hasFailedDelivery(data)) {
        toast(t('settings.passwordLinkDeliveryFailed'), 'warning');
      }
      await loadUsers();
    } catch (err) {
      setError(err instanceof Error ? err.message : t('common.networkError'));
    }
    setSaving(false);
  };

  const handleUpdate = async () => {
    if (!editUser) return;
    setSaving(true);
    setError('');
    try {
      const res = await authFetch(`/api/admin/users/${editUser.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nickname: editUser.nickname,
          role: editUser.role === 'super' ? undefined : editUser.role,
        }),
      });
      if (res.ok) {
        setEditUser(null);
        await loadUsers();
      } else {
        const data = await res.json();
        setError(data.error || t('common.saveFailed'));
      }
    } catch (_err) {
      setError(t('common.networkError'));
    }
    setSaving(false);
  };

  const handleResetPassword = async (user: ManagedUser) => {
    setResetPwdUser(user);
    setResetPwdValue('');
    setResetMode(passwordLinkCapability?.available ? 'email_link' : 'direct_password');
  };

  const executeResetPassword = async () => {
    if (!resetPwdUser || (resetMode === 'direct_password' && resetPwdValue.length < 8)) {
      toast(t('settings.passwordMinLength'), 'warning');
      return;
    }
    try {
      const data = await resetManagedUserPassword(
        resetPwdUser.id,
        resetMode === 'email_link' ? { mode: 'email_link' } : { mode: 'direct_password', password: resetPwdValue },
      );
      const deliveryFailed = hasFailedDelivery(data);
      toast(
        resetMode === 'email_link'
          ? deliveryFailed
            ? t('settings.passwordLinkDeliveryFailed')
            : t('settings.passwordLinkSent')
          : t('settings.passwordReset'),
        deliveryFailed ? 'warning' : 'success',
      );
      await loadUsers();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('settings.resetFailed'), 'error');
    }
    setResetPwdUser(null);
    setResetPwdValue('');
  };

  const resendPasswordLink = async (user: ManagedUser) => {
    try {
      const data = await resendManagedUserPasswordLink(user.id);
      toast(
        data.delivery?.status === 'failed'
          ? t('settings.passwordLinkDeliveryFailed')
          : t('settings.passwordLinkResent'),
        data.delivery?.status === 'failed' ? 'warning' : 'success',
      );
      await loadUsers();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('settings.passwordLinkResendFailed'), 'error');
    }
  };

  const revokePasswordLink = async () => {
    if (!revokeLinkTarget) return;
    const user = revokeLinkTarget;
    setRevokeLinkTarget(null);
    try {
      await revokeManagedUserPasswordLink(user.id);
      toast(t('settings.passwordLinkRevoked'), 'success');
      await loadUsers();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('common.operationFailed'), 'error');
    }
  };

  const handleToggleStatus = async (user: ManagedUser) => {
    const newStatus = user.status === 'disabled' ? 'active' : 'disabled';
    const action = newStatus === 'disabled' ? t('settings.disable') : t('settings.enable');
    setPendingAction({ user, action, newStatus });
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;
    const { user, newStatus } = pendingAction;
    setPendingAction(null);
    setEditUser(null);
    try {
      const res = await authFetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: newStatus,
          ...(newStatus === 'active' && user.role === 'external' ? { role: 'team' } : {}),
        }),
      });
      if (res.ok) await loadUsers();
      else {
        const data = await res.json();
        toast(data.error || t('common.operationFailed'), 'error');
      }
    } catch (_err) {
      toast(t('common.networkError'), 'error');
    }
  };

  const executeDeleteUser = async () => {
    if (!deleteTarget) return;
    const userId = deleteTarget.id;
    setDeleteTarget(null);
    setEditUser(null);
    try {
      const res = await authFetch(`/api/admin/users/${userId}`, { method: 'DELETE' });
      if (res.ok) {
        toast(t('settings.userDeleted'), 'success');
        await loadUsers();
      } else {
        const data = await res.json();
        toast(data.error || t('settings.deleteFailed'), 'error');
      }
    } catch (_err) {
      toast(t('common.networkError'), 'error');
    }
  };

  if (loading)
    return (
      <ModulePage moduleId="admin.users" layout="list">
        <div className="overflow-hidden rounded-xl border border-edge bg-surface-raised">
          <table className="w-full">
            <tbody>
              {[...Array(5)].map((_, i) => (
                <SkeletonRow key={i} cols={7} />
              ))}
            </tbody>
          </table>
        </div>
      </ModulePage>
    );

  return (
    <ModulePage
      moduleId="admin.users"
      layout="list"
      actions={
        <Button
          size="sm"
          data-testid="users-add"
          onClick={() => {
            setShowCreate(true);
            setError('');
          }}
        >
          {t('settings.addUser')}
        </Button>
      }
      toolbar={
        <div className="flex flex-wrap items-center gap-2">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder={t('settings.searchUsers')}
            size="sm"
            className="flex-1 min-w-[140px] sm:flex-none sm:w-[200px]"
          />
          <Select value={filterRole} onChange={(e) => setFilterRole(e.target.value)} size="sm" inline>
            <option value="">{t('settings.filterByRole')}</option>
            <option value="super">{t('settings.roleSuper')}</option>
            <option value="team">{t('settings.roleTeam')}</option>
          </Select>
          <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} size="sm" inline>
            <option value="">{t('settings.filterByStatus')}</option>
            <option value="active">{t('common.active')}</option>
            <option value="invited">{t('settings.statusInvited')}</option>
            <option value="reset_required">{t('settings.statusResetRequired')}</option>
            <option value="disabled">{t('common.disabled')}</option>
          </Select>
          <Select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} size="sm" inline>
            <option value="default">{t('settings.sortByDefault')}</option>
            <option value="month_tokens">{t('settings.sortByTokenUsage')}</option>
            <option value="total_calls">{t('settings.sortByTotalCalls')}</option>
            <option value="last_login">{t('settings.sortByLastLogin')}</option>
          </Select>
          <div className="flex-1" />
          <span className="text-xs text-fg-muted whitespace-nowrap">
            {t('settings.totalUsers', { count: String(filteredUsers.length) })}
            {filteredUsers.length !== users.length && <span className="text-fg-faint"> / {users.length}</span>}
          </span>
        </div>
      }
    >
      <div className="space-y-4">
        {!showCreate && error && <p className="text-sm text-danger bg-danger-subtle px-3 py-2 rounded-lg">{error}</p>}

        <Dialog
          open={showCreate}
          onClose={() => {
            if (!saving) setShowCreate(false);
          }}
          title={t('settings.addNewUser')}
          size="lg"
        >
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void handleCreate();
            }}
          >
            <FormGrid>
              <FormField label={t('common.email')} required>
                <Input
                  placeholder={t('settings.emailPlaceholder')}
                  type="email"
                  data-testid="users-field-email"
                  value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </FormField>
              <FormField label={t('common.nickname')} required>
                <Input
                  placeholder={t('settings.nicknamePlaceholder')}
                  data-testid="users-field-nickname"
                  value={form.nickname}
                  onChange={(e) => setForm({ ...form, nickname: e.target.value })}
                />
              </FormField>
              <FormField label={t('settings.credentialMethod')} help={passwordLinkUnavailableText || undefined}>
                <Select
                  value={form.credential_mode}
                  onChange={(e) =>
                    setForm({ ...form, credential_mode: e.target.value as 'email_link' | 'direct_password' })
                  }
                >
                  <option value="email_link" disabled={!passwordLinkCapability?.available}>
                    {t('settings.sendSetupLinkRecommended')}
                  </option>
                  <option value="direct_password">{t('settings.setPasswordDirectly')}</option>
                </Select>
              </FormField>
              {form.credential_mode === 'direct_password' && (
                <FormField label={t('login.password')} required>
                  <Input
                    placeholder={t('settings.passwordPlaceholder')}
                    type="password"
                    autoComplete="new-password"
                    data-testid="users-field-password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                  />
                </FormField>
              )}
              <FormField label={t('common.role')}>
                <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
                  <option value="team">{t('settings.roleTeam')}</option>
                </Select>
              </FormField>
              <FormField label={t('settings.monthlyTokenLimit')}>
                <Input
                  type="number"
                  value={form.monthly_token_limit}
                  onChange={(e) => setForm({ ...form, monthly_token_limit: parseInt(e.target.value) || 0 })}
                />
              </FormField>
            </FormGrid>
            <FormError>{error}</FormError>
            <FormActions>
              <Button variant="ghost" size="sm" type="button" onClick={() => setShowCreate(false)} disabled={saving}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" type="submit" disabled={saving} data-testid="users-submit">
                {saving ? t('common.saving') : t('common.create')}
              </Button>
            </FormActions>
          </form>
        </Dialog>

        {/* User table */}
        <div className="bg-surface-raised border border-edge rounded-xl overflow-hidden overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="bg-surface-sunken border-b border-edge text-[11px] text-fg-muted font-medium uppercase tracking-wider">
                <th className="text-left py-2.5 px-3">{t('usage.user')}</th>
                <th className="text-left py-2.5 px-3">{t('common.role')}</th>
                <th className="text-left py-2.5 px-3">{t('common.status')}</th>
                <th className="text-right py-2.5 px-3">
                  <button
                    className={`inline-flex items-center gap-1 hover:text-fg-secondary transition-colors ${sortKey === 'month_tokens' ? 'text-fg-secondary' : ''}`}
                    onClick={() => setSortKey(sortKey === 'month_tokens' ? 'default' : 'month_tokens')}
                  >
                    {t('settings.monthTokens')}
                    <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="text-right py-2.5 px-3">
                  <button
                    className={`inline-flex items-center gap-1 hover:text-fg-secondary transition-colors ${sortKey === 'total_calls' ? 'text-fg-secondary' : ''}`}
                    onClick={() => setSortKey(sortKey === 'total_calls' ? 'default' : 'total_calls')}
                  >
                    {t('usage.totalCalls')}
                    <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="text-right py-2.5 px-3">
                  <button
                    className={`inline-flex items-center gap-1 hover:text-fg-secondary transition-colors ${sortKey === 'last_login' ? 'text-fg-secondary' : ''}`}
                    onClick={() => setSortKey(sortKey === 'last_login' ? 'default' : 'last_login')}
                  >
                    {t('settings.sortByLastLogin')}
                    <ArrowUpDown size={10} />
                  </button>
                </th>
                <th className="text-center py-2.5 px-3">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {filteredUsers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-8 text-center text-sm text-fg-muted">
                    {t('settings.noUsersFound')}
                  </td>
                </tr>
              ) : (
                filteredUsers.map((u) => {
                  const usage = u.usage_summary;
                  // Raw share, not the clamped bar width: past 100% the bar is
                  // pinned and stops being able to say "this account is blocked".
                  const tokenShare =
                    usage && u.monthly_token_limit > 0 ? (usage.month_tokens / u.monthly_token_limit) * 100 : 0;
                  const tokenPct = Math.min(100, tokenShare);

                  return (
                    <tr
                      key={u.id}
                      className={`hover:bg-surface-sunken/50 transition-colors ${
                        u.status === 'disabled' ? 'opacity-60' : ''
                      }`}
                    >
                      {/* User */}
                      <td className="py-2.5 px-3">
                        <div className="flex items-center gap-2.5">
                          <Avatar name={u.nickname} size="md" variant={u.role === 'super' ? 'primary' : 'default'} />
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-fg truncate" title={u.nickname}>
                              {u.nickname}
                            </div>
                            <div className="text-[11px] text-fg-faint truncate" title={u.email}>
                              {u.email}
                            </div>
                          </div>
                        </div>
                      </td>
                      {/* Role */}
                      <td className="py-2.5 px-3">
                        <Tag tone={ROLE_TONE[u.role] ?? 'neutral'} className="capitalize">
                          {u.role === 'super' ? t('settings.roleSuper') : t('settings.roleTeam')}
                        </Tag>
                      </td>
                      {/* Status */}
                      <td className="py-2.5 px-3">
                        <div className="space-y-1">
                          {u.status === 'disabled' ? (
                            <Tag tone="danger">{t('common.disabled')}</Tag>
                          ) : u.status === 'invited' ? (
                            <Tag tone="info">{t('settings.statusInvited')}</Tag>
                          ) : u.status === 'reset_required' ? (
                            <Tag tone="warning">{t('settings.statusResetRequired')}</Tag>
                          ) : (
                            <Tag tone="success">{t('common.active')}</Tag>
                          )}
                          {u.password_link && (
                            <div
                              className={`text-[10px] ${u.password_link.delivery_status === 'failed' ? 'text-danger' : 'text-fg-faint'}`}
                              title={u.password_link.delivery_error ?? undefined}
                            >
                              {u.password_link.delivery_status === 'failed'
                                ? t('settings.passwordLinkSendFailed')
                                : new Date(u.password_link.expires_at).getTime() <= Date.now()
                                  ? t('settings.passwordLinkExpired')
                                  : t('settings.passwordLinkExpires', {
                                      date: new Date(u.password_link.expires_at).toLocaleString(),
                                    })}
                            </div>
                          )}
                        </div>
                      </td>
                      {/* Month tokens */}
                      <td className="py-2.5 px-3 text-right">
                        {usage ? (
                          <div>
                            <div className="flex items-center justify-end gap-1.5">
                              {tokenShare >= 80 && (
                                <Tag
                                  tone={tokenShare >= 100 ? 'danger' : 'warning'}
                                >{`${Math.round(tokenShare)}%`}</Tag>
                              )}
                              <span className="text-xs font-medium text-fg-secondary">
                                {formatTokens(usage.month_tokens)}
                                <span className="text-fg-faint">/{formatTokens(u.monthly_token_limit)}</span>
                              </span>
                            </div>
                            <div className="w-full bg-surface-muted rounded-full h-1 mt-1">
                              <div
                                className={`h-1 rounded-full ${
                                  tokenShare >= 100 ? 'bg-danger' : tokenShare >= 80 ? 'bg-warning' : 'bg-primary-400'
                                }`}
                                style={{ width: `${tokenPct}%` }}
                              />
                            </div>
                          </div>
                        ) : (
                          <span className="text-xs text-fg-faint">—</span>
                        )}
                      </td>
                      {/* Total calls */}
                      <td className="py-2.5 px-3 text-right">
                        <span className="text-xs font-medium text-fg-secondary">
                          {usage ? usage.total_calls.toLocaleString() : '—'}
                        </span>
                      </td>
                      {/* Last login */}
                      <td className="py-2.5 px-3 text-right text-xs text-fg-faint">
                        {u.last_login_at
                          ? new Date(u.last_login_at).toLocaleDateString('zh-CN')
                          : t('common.neverLoggedIn')}
                      </td>
                      {/* Actions */}
                      <td className="py-2.5 px-3 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {u.role !== 'super' && (
                            <IconButton
                              label={t('common.edit')}
                              size="compact"
                              data-testid="users-edit"
                              onClick={() => {
                                setEditUser({ ...u });
                                setError('');
                              }}
                            >
                              <Pencil size={13} />
                            </IconButton>
                          )}
                          <IconButton
                            label={t('settings.permissions')}
                            size="compact"
                            onClick={() =>
                              setPermUser({ id: u.id, nickname: u.nickname, email: u.email, role: u.role })
                            }
                          >
                            <Shield size={13} />
                          </IconButton>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Edit dialog */}
        <Dialog open={!!editUser} onClose={() => setEditUser(null)} title={t('settings.editUser')} size="lg">
          {editUser && (
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                void handleUpdate();
              }}
            >
              <FormGrid>
                <FormField label={t('common.nickname')} required>
                  <Input
                    value={editUser.nickname}
                    onChange={(e) => setEditUser({ ...editUser, nickname: e.target.value })}
                  />
                </FormField>
                <FormField label={t('common.role')} help={t('settings.limitsMovedToPermissions')}>
                  <Select
                    value={editUser.role}
                    onChange={(e) =>
                      setEditUser({ ...editUser, role: e.target.value === 'team' ? 'team' : editUser.role })
                    }
                    disabled={editUser.role === 'super'}
                  >
                    <option value="team">{t('settings.roleTeam')}</option>
                  </Select>
                </FormField>
              </FormGrid>
              <FormError>{error}</FormError>
              <FormActions>
                <Button variant="ghost" size="sm" type="button" onClick={() => setEditUser(null)}>
                  {t('common.cancel')}
                </Button>
                <Button size="sm" type="submit" disabled={saving || !editUser.nickname.trim()}>
                  {saving ? t('common.saving') : t('common.save')}
                </Button>
              </FormActions>

              {/* Account actions (secondary) */}
              <FormSection title={t('settings.account')} description={t('settings.accountActionsDescription')}>
                <div className="flex flex-wrap gap-2">
                  <Button variant="ghost" size="sm" type="button" onClick={() => handleResetPassword(editUser)}>
                    <Key size={13} className="mr-1.5" />
                    {t('settings.resetPassword')}
                  </Button>
                  {(editUser.status === 'invited' || editUser.status === 'reset_required') && (
                    <Button
                      variant="ghost"
                      size="sm"
                      type="button"
                      onClick={() => void resendPasswordLink(editUser)}
                      disabled={!passwordLinkCapability?.available}
                      title={passwordLinkUnavailableText || undefined}
                    >
                      <RefreshCw size={13} className="mr-1.5" />
                      {t('settings.resendPasswordLink')}
                    </Button>
                  )}
                  {editUser.password_link && (
                    <Button variant="ghost" size="sm" type="button" onClick={() => setRevokeLinkTarget(editUser)}>
                      <XCircle size={13} className="mr-1.5" />
                      {t('settings.revokePasswordLink')}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" type="button" onClick={() => handleToggleStatus(editUser)}>
                    {editUser.status !== 'disabled' ? (
                      <Ban size={13} className="mr-1.5" />
                    ) : (
                      <Check size={13} className="mr-1.5" />
                    )}
                    {editUser.status !== 'disabled' ? t('settings.disable') : t('settings.enable')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    type="button"
                    onClick={() => setDeleteTarget(editUser)}
                    data-testid="users-delete"
                    className="text-danger hover:text-danger"
                  >
                    <Trash2 size={13} className="mr-1.5" />
                    {t('settings.deleteUser')}
                  </Button>
                </div>
              </FormSection>
            </form>
          )}
        </Dialog>

        {/* Toggle status confirm */}
        <ConfirmDialog
          open={!!pendingAction}
          onClose={() => setPendingAction(null)}
          onConfirm={executePendingAction}
          title={t('settings.disableUserConfirm', {
            action: pendingAction?.action || '',
            name: pendingAction?.user.nickname || '',
          })}
          confirmLabel={pendingAction?.action || t('common.confirm')}
          confirmVariant={pendingAction?.newStatus === 'disabled' ? 'destructive' : 'default'}
        />

        <ConfirmDialog
          open={!!revokeLinkTarget}
          onClose={() => setRevokeLinkTarget(null)}
          onConfirm={revokePasswordLink}
          title={t('settings.revokePasswordLinkConfirm', { name: revokeLinkTarget?.nickname || '' })}
          confirmLabel={t('settings.revokePasswordLink')}
          confirmVariant="destructive"
        />

        {/* Delete user confirm */}
        <ConfirmDialog
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={executeDeleteUser}
          title={t('settings.deleteUserConfirm', { name: deleteTarget?.nickname || '' })}
          confirmLabel={t('settings.deleteUser')}
          confirmVariant="destructive"
        />

        {/* Reset password dialog */}
        <Dialog
          open={!!resetPwdUser}
          onClose={() => setResetPwdUser(null)}
          title={t('settings.resetPassword')}
          size="sm"
        >
          <div className="space-y-3">
            <Select value={resetMode} onChange={(e) => setResetMode(e.target.value as typeof resetMode)}>
              <option value="email_link" disabled={!passwordLinkCapability?.available}>
                {t('settings.sendResetLinkRecommended')}
              </option>
              <option value="direct_password">{t('settings.setPasswordDirectly')}</option>
            </Select>
            {resetMode === 'email_link' ? (
              <div className="rounded-lg border border-warning/30 bg-warning-subtle px-3 py-2 text-xs leading-5 text-fg-secondary">
                <Mail size={14} className="mr-1.5 inline" />
                {t('settings.resetLinkImmediateWarning')}
                {passwordLinkUnavailableText && <p className="mt-1 text-warning">{passwordLinkUnavailableText}</p>}
              </div>
            ) : (
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={t('settings.enterNewPassword')}
                value={resetPwdValue}
                onChange={(e) => setResetPwdValue(e.target.value)}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) executeResetPassword();
                }}
              />
            )}
            <div className="flex gap-2 justify-end">
              <Button variant="ghost" size="sm" onClick={() => setResetPwdUser(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={executeResetPassword}
                disabled={
                  resetMode === 'direct_password' ? resetPwdValue.length < 8 : !passwordLinkCapability?.available
                }
              >
                {t('common.confirm')}
              </Button>
            </div>
          </div>
        </Dialog>

        {/* Unified permission modal (features + capabilities + tools + limits) */}
        <UserPermissionsModal user={permUser} open={!!permUser} onClose={() => setPermUser(null)} />
      </div>
    </ModulePage>
  );
}
