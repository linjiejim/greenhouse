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
} from '../../components/ui';
import { Pencil, Key, Ban, Check, Wrench, Trash2, ArrowUpDown, Bot, Sparkles } from '../../lib/icons';
import { authFetch } from '../../lib/auth';
import {
  formatTokens,
  fetchUserTools,
  setUserTools,
  fetchTools,
  fetchUserProfiles,
  setUserProfiles,
} from '../../lib/api';
import type { ToolMeta } from '../../lib/api';
import { getToolIcon } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { ROLE_TONE } from '../../lib/utils';
import { getAllFeatureFlags } from '@greenhouse/types/features';

// ─── Types ───────────────────────────────────────────────

interface ManagedUser {
  id: string;
  email: string;
  nickname: string;
  role: string;
  status: string;
  daily_message_limit: number;
  monthly_token_limit: number;
  created_at: string;
  last_login_at: string | null;
  usage_summary?: {
    total_calls: number;
    today_messages: number;
    month_tokens: number;
    last_used_at: string | null;
  } | null;
}

type SortKey = 'default' | 'month_tokens' | 'total_calls' | 'last_login';

// ─── Main Component ──────────────────────────────────────

export function UserManagementPanel() {
  const t = useT();
  const [users, setUsers] = useState<ManagedUser[]>([]);
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
  const [resetPwdUser, setResetPwdUser] = useState<string | null>(null);
  const [resetPwdValue, setResetPwdValue] = useState('');
  const [toolAssignUser, setToolAssignUser] = useState<ManagedUser | null>(null);
  const [allTools, setAllTools] = useState<ToolMeta[]>([]);
  const [assignedToolIds, setAssignedToolIds] = useState<Set<string>>(new Set());
  const [savingTools, setSavingTools] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ManagedUser | null>(null);
  const [profileAssignUser, setProfileAssignUser] = useState<ManagedUser | null>(null);
  const [availableProfileIds, setAvailableProfileIds] = useState<string[]>([]);
  const [assignedProfileIds, setAssignedProfileIds] = useState<Set<string>>(new Set());
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [featureAssignUser, setFeatureAssignUser] = useState<ManagedUser | null>(null);
  const [userFeatures, setUserFeatures] = useState<Record<string, boolean>>({});
  const [savingFeatures, setSavingFeatures] = useState(false);

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
    daily_message_limit: 50,
    monthly_token_limit: 5000000,
  });

  const loadUsers = async () => {
    setLoading(true);
    try {
      const res = await authFetch('/api/admin/users');
      if (res.ok) {
        const data = await res.json();
        setUsers(data.users);
      }
    } catch (_err) {
      /* ignore */
    }
    setLoading(false);
  };

  useEffect(() => {
    loadUsers();
  }, []);

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
    if (!form.email || !form.password || !form.nickname) {
      setError(t('settings.fillRequiredFields'));
      return;
    }
    if (form.password.length < 8) {
      setError(t('settings.passwordMinLength'));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const res = await authFetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (res.ok) {
        setShowCreate(false);
        setForm({
          email: '',
          password: '',
          nickname: '',
          role: 'team',
          daily_message_limit: 50,
          monthly_token_limit: 5000000,
        });
        await loadUsers();
      } else {
        const data = await res.json();
        setError(data.error || t('common.createFailed'));
      }
    } catch (_err) {
      setError(t('common.networkError'));
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
          status: editUser.status,
          daily_message_limit: editUser.daily_message_limit,
          monthly_token_limit: editUser.monthly_token_limit,
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

  const handleResetPassword = async (userId: string) => {
    setResetPwdUser(userId);
    setResetPwdValue('');
  };

  const executeResetPassword = async () => {
    if (!resetPwdUser || resetPwdValue.length < 8) {
      toast(t('settings.passwordMinLength'), 'warning');
      return;
    }
    try {
      const res = await authFetch(`/api/admin/users/${resetPwdUser}/reset-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: resetPwdValue }),
      });
      if (res.ok) {
        toast(t('settings.passwordReset'), 'success');
      } else {
        const data = await res.json();
        toast(data.error || t('settings.resetFailed'), 'error');
      }
    } catch (_err) {
      toast(t('common.networkError'), 'error');
    }
    setResetPwdUser(null);
    setResetPwdValue('');
  };

  const openToolAssign = async (user: ManagedUser) => {
    setToolAssignUser(user);
    try {
      const [toolsData, userToolsData] = await Promise.all([fetchTools(), fetchUserTools(user.id)]);
      setAllTools(toolsData);
      setAssignedToolIds(new Set(userToolsData.assigned));
    } catch (_err) {
      toast(t('settings.loadToolsFailed'), 'error');
    }
  };

  const openProfileAssign = async (user: ManagedUser) => {
    setProfileAssignUser(user);
    try {
      const data = await fetchUserProfiles(user.id);
      setAvailableProfileIds(data.available);
      setAssignedProfileIds(new Set(data.assigned));
    } catch (_err) {
      toast(t('settings.loadToolsFailed'), 'error');
    }
  };

  const handleToggleProfileAssign = (profileId: string) => {
    setAssignedProfileIds((prev) => {
      const next = new Set(prev);
      if (next.has(profileId)) next.delete(profileId);
      else next.add(profileId);
      return next;
    });
  };

  const handleSaveProfileAssign = async () => {
    if (!profileAssignUser) return;
    setSavingProfiles(true);
    try {
      await setUserProfiles(profileAssignUser.id, [...assignedProfileIds]);
      toast(t('settings.toolsSaved'), 'success');
      setProfileAssignUser(null);
    } catch (_err) {
      toast(t('common.saveFailed'), 'error');
    }
    setSavingProfiles(false);
  };

  // ── Feature Toggle ──────────────────────────────────

  /** Known features — single source of truth: @greenhouse/types/features
   *  (core + any fork-registered flags). */
  const KNOWN_FEATURES = getAllFeatureFlags().map((f) => ({ id: f.key, label: f.label, description: f.description }));

  const openFeatureAssign = async (user: ManagedUser) => {
    setFeatureAssignUser(user);
    try {
      const res = await authFetch(`/api/admin/users/${user.id}/features`);
      if (res.ok) {
        const data = await res.json();
        const map: Record<string, boolean> = {};
        for (const f of data.features) {
          map[f.feature] = f.enabled;
        }
        setUserFeatures(map);
      }
    } catch (_err) {
      toast('Failed to load features', 'error');
    }
  };

  const handleToggleFeature = async (featureId: string, enabled: boolean) => {
    if (!featureAssignUser) return;
    setSavingFeatures(true);
    try {
      const res = await authFetch(`/api/admin/users/${featureAssignUser.id}/features`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature: featureId, enabled }),
      });
      if (res.ok) {
        setUserFeatures((prev) => ({ ...prev, [featureId]: enabled }));
      } else {
        const data = await res.json();
        toast(data.error || 'Failed to update feature', 'error');
      }
    } catch (_err) {
      toast('Network error', 'error');
    }
    setSavingFeatures(false);
  };

  const handleToggleToolAssign = (toolId: string) => {
    setAssignedToolIds((prev) => {
      const next = new Set(prev);
      if (next.has(toolId)) next.delete(toolId);
      else next.add(toolId);
      return next;
    });
  };

  const handleSaveToolAssign = async () => {
    if (!toolAssignUser) return;
    setSavingTools(true);
    try {
      await setUserTools(toolAssignUser.id, [...assignedToolIds]);
      toast(t('settings.toolsSaved'), 'success');
      setToolAssignUser(null);
    } catch (_err) {
      toast(t('common.saveFailed'), 'error');
    }
    setSavingTools(false);
  };

  const handleToggleStatus = async (user: ManagedUser) => {
    const newStatus = user.status === 'active' ? 'disabled' : 'active';
    const action = newStatus === 'disabled' ? t('settings.disable') : t('settings.enable');
    setPendingAction({ user, action, newStatus });
  };

  const executePendingAction = async () => {
    if (!pendingAction) return;
    const { user, newStatus } = pendingAction;
    setPendingAction(null);
    try {
      const res = await authFetch(`/api/admin/users/${user.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
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
      <div className="space-y-0">
        <table className="w-full">
          <tbody>
            {[...Array(5)].map((_, i) => (
              <SkeletonRow key={i} cols={7} />
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <div className="space-y-4">
      {/* Toolbar */}
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
          <option value="super">Super</option>
          <option value="team">Team</option>
          <option value="external">External</option>
        </Select>
        <Select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} size="sm" inline>
          <option value="">{t('settings.filterByStatus')}</option>
          <option value="active">Active</option>
          <option value="disabled">Disabled</option>
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
      </div>

      {error && <p className="text-sm text-danger bg-danger-subtle px-3 py-2 rounded-lg">{error}</p>}

      {/* Create form */}
      {showCreate && (
        <div className="bg-surface-sunken rounded-xl p-4 space-y-3 border border-edge">
          <h4 className="text-sm font-medium text-fg">{t('settings.addNewUser')}</h4>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              data-testid="user-email-input"
              placeholder={t('settings.emailPlaceholder')}
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
            <Input
              data-testid="user-password-input"
              placeholder={t('settings.passwordPlaceholder')}
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <Input
              data-testid="user-nickname-input"
              placeholder={t('settings.nicknamePlaceholder')}
              value={form.nickname}
              onChange={(e) => setForm({ ...form, nickname: e.target.value })}
            />
            <Select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="team">Team</option>
              <option value="external">External</option>
            </Select>
            <Input
              placeholder={t('settings.dailyMsgLimit')}
              type="number"
              value={form.daily_message_limit}
              onChange={(e) => setForm({ ...form, daily_message_limit: parseInt(e.target.value) || 0 })}
            />
            <Input
              placeholder={t('settings.monthlyTokenLimit')}
              type="number"
              value={form.monthly_token_limit}
              onChange={(e) => setForm({ ...form, monthly_token_limit: parseInt(e.target.value) || 0 })}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={saving} data-testid="user-create-submit">
              {saving ? t('common.saving') : t('common.create')}
            </Button>
          </div>
        </div>
      )}

      {/* User table */}
      <div className="bg-surface-raised border border-edge rounded-xl overflow-hidden overflow-x-auto">
        <table className="w-full text-sm min-w-[800px]">
          <thead>
            <tr className="bg-surface-sunken border-b border-edge text-[11px] text-fg-muted font-medium uppercase tracking-wider">
              <th className="text-left py-2.5 px-3">User</th>
              <th className="text-left py-2.5 px-3">Role</th>
              <th className="text-left py-2.5 px-3">Status</th>
              <th className="text-right py-2.5 px-3">Today Msgs</th>
              <th className="text-right py-2.5 px-3">
                <button
                  className={`inline-flex items-center gap-1 hover:text-fg-secondary transition-colors ${sortKey === 'month_tokens' ? 'text-fg-secondary' : ''}`}
                  onClick={() => setSortKey(sortKey === 'month_tokens' ? 'default' : 'month_tokens')}
                >
                  Month Tokens
                  <ArrowUpDown size={10} />
                </button>
              </th>
              <th className="text-right py-2.5 px-3">
                <button
                  className={`inline-flex items-center gap-1 hover:text-fg-secondary transition-colors ${sortKey === 'total_calls' ? 'text-fg-secondary' : ''}`}
                  onClick={() => setSortKey(sortKey === 'total_calls' ? 'default' : 'total_calls')}
                >
                  Total Calls
                  <ArrowUpDown size={10} />
                </button>
              </th>
              <th className="text-right py-2.5 px-3">
                <button
                  className={`inline-flex items-center gap-1 hover:text-fg-secondary transition-colors ${sortKey === 'last_login' ? 'text-fg-secondary' : ''}`}
                  onClick={() => setSortKey(sortKey === 'last_login' ? 'default' : 'last_login')}
                >
                  Last Login
                  <ArrowUpDown size={10} />
                </button>
              </th>
              <th className="text-center py-2.5 px-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-edge">
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-sm text-fg-muted">
                  {t('settings.noUsersFound')}
                </td>
              </tr>
            ) : (
              filteredUsers.map((u) => {
                const usage = u.usage_summary;
                const msgPct =
                  usage && u.daily_message_limit > 0
                    ? Math.min(100, (usage.today_messages / u.daily_message_limit) * 100)
                    : 0;
                const tokenPct =
                  usage && u.monthly_token_limit > 0
                    ? Math.min(100, (usage.month_tokens / u.monthly_token_limit) * 100)
                    : 0;

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
                        <span
                          className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                            u.role === 'super'
                              ? 'bg-info-subtle text-info'
                              : u.role === 'team'
                                ? 'bg-info-subtle text-info'
                                : 'bg-primary-subtle-hover text-primary-fg-strong'
                          }`}
                        >
                          {u.nickname.charAt(0).toUpperCase()}
                        </span>
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
                        {u.role}
                      </Tag>
                    </td>
                    {/* Status */}
                    <td className="py-2.5 px-3">
                      {u.status === 'disabled' ? <Tag tone="danger">Disabled</Tag> : <Tag tone="success">Active</Tag>}
                    </td>
                    {/* Today messages */}
                    <td className="py-2.5 px-3 text-right">
                      {usage ? (
                        <div>
                          <div className="text-xs font-medium text-fg-secondary">
                            {usage.today_messages}
                            <span className="text-fg-faint">/{u.daily_message_limit}</span>
                          </div>
                          <div className="w-full bg-surface-muted rounded-full h-1 mt-1">
                            <div
                              className={`h-1 rounded-full ${msgPct > 80 ? 'bg-danger' : 'bg-primary-400'}`}
                              style={{ width: `${msgPct}%` }}
                            />
                          </div>
                        </div>
                      ) : (
                        <span className="text-xs text-fg-faint">—</span>
                      )}
                    </td>
                    {/* Month tokens */}
                    <td className="py-2.5 px-3 text-right">
                      {usage ? (
                        <div>
                          <div className="text-xs font-medium text-fg-secondary">
                            {formatTokens(usage.month_tokens)}
                            <span className="text-fg-faint">/{formatTokens(u.monthly_token_limit)}</span>
                          </div>
                          <div className="w-full bg-surface-muted rounded-full h-1 mt-1">
                            <div
                              className={`h-1 rounded-full ${tokenPct > 80 ? 'bg-danger' : 'bg-primary-400'}`}
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
                      {u.role !== 'super' ? (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => {
                              setEditUser({ ...u });
                              setError('');
                            }}
                            className="text-xs text-fg-faint hover:text-primary-fg p-1.5 rounded hover:bg-surface-muted"
                            title={t('common.edit')}
                          >
                            <Pencil size={13} />
                          </button>
                          <button
                            onClick={() => openToolAssign(u)}
                            className="text-xs text-fg-faint hover:text-primary-fg p-1.5 rounded hover:bg-surface-muted"
                            title={t('settings.toolAssignment')}
                          >
                            <Wrench size={13} />
                          </button>
                          <button
                            onClick={() => openFeatureAssign(u)}
                            className="text-xs text-fg-faint hover:text-purple-500 p-1.5 rounded hover:bg-surface-muted"
                            title="Feature Toggles"
                          >
                            <Sparkles size={13} />
                          </button>
                          <button
                            onClick={() => handleResetPassword(u.id)}
                            className="text-xs text-fg-faint hover:text-warning p-1.5 rounded hover:bg-surface-muted"
                            title={t('settings.resetPassword')}
                          >
                            <Key size={13} />
                          </button>
                          <button
                            onClick={() => handleToggleStatus(u)}
                            className={`text-xs p-1.5 rounded hover:bg-surface-muted ${
                              u.status === 'active'
                                ? 'text-fg-faint hover:text-danger'
                                : 'text-fg-faint hover:text-success'
                            }`}
                            title={u.status === 'active' ? t('settings.disable') : t('settings.enable')}
                          >
                            {u.status === 'active' ? <Ban size={13} /> : <Check size={13} />}
                          </button>
                          <button
                            onClick={() => setDeleteTarget(u)}
                            data-testid={`user-delete-${u.email}`}
                            className="text-xs text-fg-faint hover:text-danger p-1.5 rounded hover:bg-surface-muted"
                            title={t('settings.deleteUser')}
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-center gap-1">
                          <button
                            onClick={() => openFeatureAssign(u)}
                            className="text-xs text-fg-faint hover:text-purple-500 p-1.5 rounded hover:bg-surface-muted"
                            title="Feature Toggles"
                          >
                            <Sparkles size={13} />
                          </button>
                        </div>
                      )}
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
          <div className="space-y-3">
            <div>
              <label className="text-xs text-fg-muted mb-1 block">{t('common.nickname')}</label>
              <Input
                value={editUser.nickname}
                onChange={(e) => setEditUser({ ...editUser, nickname: e.target.value })}
              />
            </div>
            <div>
              <label className="text-xs text-fg-muted mb-1 block">{t('common.role')}</label>
              <Select
                value={editUser.role}
                onChange={(e) => setEditUser({ ...editUser, role: e.target.value })}
                disabled={editUser.role === 'super'}
              >
                <option value="team">Team</option>
                <option value="external">External</option>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-fg-muted mb-1 block">{t('settings.dailyMsgLimit')}</label>
                <Input
                  type="number"
                  value={editUser.daily_message_limit}
                  onChange={(e) => setEditUser({ ...editUser, daily_message_limit: parseInt(e.target.value) || 0 })}
                />
              </div>
              <div>
                <label className="text-xs text-fg-muted mb-1 block">{t('settings.monthlyTokenLimit')}</label>
                <Input
                  type="number"
                  value={editUser.monthly_token_limit}
                  onChange={(e) => setEditUser({ ...editUser, monthly_token_limit: parseInt(e.target.value) || 0 })}
                />
              </div>
            </div>
            {error && <p className="text-sm text-danger">{error}</p>}
            <div className="flex gap-2 justify-end mt-4">
              <Button variant="ghost" size="sm" onClick={() => setEditUser(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={handleUpdate} disabled={saving}>
                {saving ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
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
      <Dialog open={!!resetPwdUser} onClose={() => setResetPwdUser(null)} title={t('settings.resetPassword')} size="sm">
        <div className="space-y-3">
          <Input
            type="password"
            placeholder={t('settings.enterNewPassword')}
            value={resetPwdValue}
            onChange={(e) => setResetPwdValue(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) executeResetPassword();
            }}
          />
          <div className="flex gap-2 justify-end">
            <Button variant="ghost" size="sm" onClick={() => setResetPwdUser(null)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" onClick={executeResetPassword} disabled={resetPwdValue.length < 8}>
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Tool Assignment Dialog */}
      <Dialog
        open={!!toolAssignUser}
        onClose={() => setToolAssignUser(null)}
        title={t('settings.toolAssignTitle', { name: toolAssignUser?.nickname || '' })}
        size="xl"
      >
        {toolAssignUser && (
          <div className="space-y-3">
            <p className="text-xs text-fg-muted">{t('settings.toolAssignHint')}</p>
            <div className="max-h-[70vh] overflow-y-auto space-y-1">
              {(['public', 'team', 'admin'] as const).map((cat) => {
                const catTools = allTools.filter((t) => t.category === cat);
                if (catTools.length === 0) return null;
                return (
                  <div key={cat} className="mb-2">
                    <div className="px-1 pt-2 pb-1">
                      <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider">
                        {cat === 'public' ? t('settings.publicGlobal') : cat === 'team' ? 'Team' : 'Admin'}
                      </span>
                    </div>
                    <div className="space-y-0.5">
                      {[...catTools]
                        // Selected first: always-on (2) > assigned (1) > unselected (0).
                        // Array.sort is stable, so each tier keeps its sort_order.
                        .sort((a, b) => {
                          const rank = (x: ToolMeta) => (x.is_global ? 2 : assignedToolIds.has(x.id) ? 1 : 0);
                          return rank(b) - rank(a);
                        })
                        .map((t) => {
                          const isGlobal = t.is_global;
                          const isAssigned = isGlobal || assignedToolIds.has(t.id);
                          const Icon = getToolIcon(t.id);
                          return (
                            <button
                              key={t.id}
                              onClick={() => !isGlobal && handleToggleToolAssign(t.id)}
                              disabled={isGlobal}
                              className={`w-full text-left px-2 py-2 rounded-lg transition-colors flex items-center gap-2.5 ${
                                isGlobal
                                  ? 'cursor-default'
                                  : isAssigned
                                    ? 'bg-primary-subtle hover:bg-primary-subtle-hover'
                                    : 'hover:bg-surface-sunken opacity-70'
                              }`}
                            >
                              <div
                                className={`w-[18px] h-[18px] rounded-[4px] border-[1.5px] flex items-center justify-center flex-shrink-0 transition-all ${
                                  isAssigned
                                    ? 'bg-primary-500 border-primary-500 text-white shadow-sm'
                                    : 'border-edge-strong bg-surface-raised'
                                }`}
                              >
                                {isAssigned && <Check size={12} strokeWidth={3} className="text-white" />}
                              </div>
                              <Icon
                                size={14}
                                className={`flex-shrink-0 ${isAssigned ? 'text-primary-fg' : 'text-fg-faint'}`}
                              />
                              <div className="flex-1 min-w-0">
                                <span
                                  className={`text-xs font-medium ${isAssigned ? 'text-fg-secondary' : 'text-fg-faint'}`}
                                >
                                  {t.name}
                                </span>
                                <span className="text-[11px] text-fg-faint ml-2">{t.brief}</span>
                              </div>
                              {isGlobal && (
                                <span className="text-[9px] text-fg-faint bg-surface-muted px-1.5 py-0.5 rounded-full">
                                  always on
                                </span>
                              )}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="flex gap-2 justify-end pt-2 border-t border-edge">
              <Button variant="ghost" size="sm" onClick={() => setToolAssignUser(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={handleSaveToolAssign} disabled={savingTools}>
                {savingTools ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Profile Assignment Dialog */}
      <Dialog
        open={!!profileAssignUser}
        onClose={() => setProfileAssignUser(null)}
        title={`Assign Profiles — ${profileAssignUser?.nickname || ''}`}
        size="md"
      >
        {profileAssignUser && (
          <div className="space-y-3">
            <p className="text-xs text-fg-muted">
              Select which Agent profiles this user can access. Super users always have access to all profiles.
            </p>
            <div className="max-h-80 overflow-y-auto space-y-1">
              {availableProfileIds.length === 0 ? (
                <p className="text-xs text-fg-faint py-4 text-center">No profiles available</p>
              ) : (
                availableProfileIds.map((pid) => {
                  const isAssigned = assignedProfileIds.has(pid);
                  return (
                    <button
                      key={pid}
                      onClick={() => handleToggleProfileAssign(pid)}
                      className={`w-full text-left px-2 py-2.5 rounded-lg transition-colors flex items-center gap-2.5 ${
                        isAssigned
                          ? 'bg-primary-subtle hover:bg-primary-subtle-hover'
                          : 'hover:bg-surface-sunken opacity-60'
                      }`}
                    >
                      <div
                        className={`w-[18px] h-[18px] rounded-[4px] border-[1.5px] flex items-center justify-center flex-shrink-0 transition-all ${
                          isAssigned
                            ? 'bg-primary-500 border-primary-500 text-white shadow-sm'
                            : 'border-edge-strong bg-surface-raised'
                        }`}
                      >
                        {isAssigned && <Check size={12} strokeWidth={3} className="text-white" />}
                      </div>
                      <Bot size={14} className={`flex-shrink-0 ${isAssigned ? 'text-primary-fg' : 'text-fg-faint'}`} />
                      <span
                        className={`text-xs font-medium capitalize ${isAssigned ? 'text-fg-secondary' : 'text-fg-faint'}`}
                      >
                        {pid}
                      </span>
                    </button>
                  );
                })
              )}
            </div>
            <div className="flex gap-2 justify-end pt-2 border-t border-edge">
              <Button variant="ghost" size="sm" onClick={() => setProfileAssignUser(null)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={handleSaveProfileAssign} disabled={savingProfiles}>
                {savingProfiles ? t('common.saving') : t('common.save')}
              </Button>
            </div>
          </div>
        )}
      </Dialog>

      {/* Feature Toggle Dialog */}
      <Dialog
        open={!!featureAssignUser}
        onClose={() => setFeatureAssignUser(null)}
        title={`Features — ${featureAssignUser?.nickname || ''}`}
        size="sm"
      >
        {featureAssignUser && (
          <div className="space-y-3">
            <p className="text-xs text-fg-muted">
              Enable or disable experimental features for this user. Changes take effect on their next conversation.
            </p>
            <div className="space-y-2">
              {KNOWN_FEATURES.map((feat) => {
                const enabled = userFeatures[feat.id] ?? false;
                return (
                  <div
                    key={feat.id}
                    className="flex items-center justify-between gap-3 px-3 py-3 rounded-lg bg-surface-sunken border border-edge"
                  >
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-fg-default">{feat.label}</div>
                      <div className="text-xs text-fg-muted mt-0.5">{feat.description}</div>
                    </div>
                    <button
                      onClick={() => handleToggleFeature(feat.id, !enabled)}
                      disabled={savingFeatures}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0 ${
                        enabled ? 'bg-primary-500' : 'bg-surface-muted border border-edge'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                          enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`}
                      />
                    </button>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-end pt-2 border-t border-edge">
              <Button variant="ghost" size="sm" onClick={() => setFeatureAssignUser(null)}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
