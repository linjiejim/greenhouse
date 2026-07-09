/**
 * User Management Panel — 用户管理，on @greenhouse/crud.
 *
 * The list (toolbar + filters + sortable table + pagination), the create/edit
 * Dialog, the delete-confirm, and the enable/disable toggle all come from one
 * `defineCrud` schema. The four bespoke pickers (Tool Assignment, Feature
 * Toggles, Reset Password, Profile Assignment) stay as their own dialogs, opened
 * from `tableActions`, with their open-state held in this component.
 */

import React, { useState, useMemo, useCallback, useRef } from 'react';
import { defineCrud, CrudPage, type CrudDataSource } from '@greenhouse/crud';
import { Button, Input, Dialog, toast, Tag } from '../../components/ui';
import { Key, Wrench, Bot, Sparkles, Check, Users } from '../../lib/icons';
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

// `password` is an add-only form field, not a row property.
type UserRow = ManagedUser & { password?: string };

// ─── Main Component ──────────────────────────────────────

export function UserManagementPanel() {
  const t = useT();

  // Bespoke dialog state (held here; the dialogs render alongside <CrudPage/>).
  const [resetPwdUser, setResetPwdUser] = useState<string | null>(null);
  const [resetPwdValue, setResetPwdValue] = useState('');
  const [toolAssignUser, setToolAssignUser] = useState<ManagedUser | null>(null);
  const [allTools, setAllTools] = useState<ToolMeta[]>([]);
  const [assignedToolIds, setAssignedToolIds] = useState<Set<string>>(new Set());
  const [savingTools, setSavingTools] = useState(false);
  const [profileAssignUser, setProfileAssignUser] = useState<ManagedUser | null>(null);
  const [availableProfileIds, setAvailableProfileIds] = useState<string[]>([]);
  const [assignedProfileIds, setAssignedProfileIds] = useState<Set<string>>(new Set());
  const [savingProfiles, setSavingProfiles] = useState(false);
  const [featureAssignUser, setFeatureAssignUser] = useState<ManagedUser | null>(null);
  const [userFeatures, setUserFeatures] = useState<Record<string, boolean>>({});
  const [savingFeatures, setSavingFeatures] = useState(false);

  // Last-fetched rows by id — used by update() to preserve the super-role rule.
  const byIdRef = useRef<Map<string, UserRow>>(new Map());

  // ─── Data source (client-side filter / sort / no paging) ───
  const dataSource = useMemo<CrudDataSource<UserRow>>(
    () => ({
      async list(params) {
        const res = await authFetch('/api/admin/users');
        const data = res.ok ? await res.json() : { users: [] };
        const all: UserRow[] = (data.users ?? []) as UserRow[];
        byIdRef.current = new Map(all.map((u) => [u.id, u]));

        let result = all;
        for (const f of params.filter ?? []) {
          if (f.key === 'email') {
            const q = String(f.value[0] ?? '').toLowerCase();
            result = result.filter((u) => u.nickname.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
          } else if (f.key === 'role') {
            result = result.filter((u) => u.role === f.value[0]);
          } else if (f.key === 'status') {
            result = result.filter((u) => u.status === f.value[0]);
          }
        }

        const sortItem = params.sort?.[0];
        if (sortItem) {
          const dir = sortItem.order === 'asc' ? 1 : -1;
          const val = (u: UserRow) => {
            switch (sortItem.key) {
              case 'month_tokens':
                return u.usage_summary?.month_tokens ?? 0;
              case 'total_calls':
                return u.usage_summary?.total_calls ?? 0;
              case 'last_login_at':
                return u.last_login_at ? new Date(u.last_login_at).getTime() : 0;
              default:
                return 0;
            }
          };
          result = [...result].sort((a, b) => (val(a) - val(b)) * dir);
        }

        return { items: result, total: result.length };
      },
      async create(data) {
        const res = await authFetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            email: data.email,
            password: data.password,
            nickname: data.nickname,
            role: data.role,
            daily_message_limit: data.daily_message_limit,
            monthly_token_limit: data.monthly_token_limit,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error || t('common.createFailed'));
        }
        return res.json().catch(() => null);
      },
      async update(id, data) {
        const isSuper = byIdRef.current.get(id)?.role === 'super';
        const res = await authFetch(`/api/admin/users/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nickname: data.nickname,
            role: isSuper ? undefined : data.role,
            daily_message_limit: data.daily_message_limit,
            monthly_token_limit: data.monthly_token_limit,
          }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error || t('common.saveFailed'));
        }
        return res.json().catch(() => null);
      },
      async remove(id) {
        const res = await authFetch(`/api/admin/users/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const err = await res.json().catch(() => null);
          throw new Error(err?.error || t('settings.deleteFailed'));
        }
      },
    }),
    [t],
  );

  // ─── Reset Password ──────────────────────────────────
  const handleResetPassword = useCallback((userId: string) => {
    setResetPwdUser(userId);
    setResetPwdValue('');
  }, []);

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

  // ─── Tool Assignment ─────────────────────────────────
  const openToolAssign = useCallback(
    async (user: ManagedUser) => {
      setToolAssignUser(user);
      try {
        const [toolsData, userToolsData] = await Promise.all([fetchTools(), fetchUserTools(user.id)]);
        setAllTools(toolsData);
        setAssignedToolIds(new Set(userToolsData.assigned));
      } catch (_err) {
        toast(t('settings.loadToolsFailed'), 'error');
      }
    },
    [t],
  );

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

  // ─── Profile Assignment ──────────────────────────────
  const openProfileAssign = useCallback(
    async (user: ManagedUser) => {
      setProfileAssignUser(user);
      try {
        const data = await fetchUserProfiles(user.id);
        setAvailableProfileIds(data.available);
        setAssignedProfileIds(new Set(data.assigned));
      } catch (_err) {
        toast(t('settings.loadToolsFailed'), 'error');
      }
    },
    [t],
  );

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

  // ─── Feature Toggle ──────────────────────────────────

  /** Known features — single source of truth: @greenhouse/types/features
   *  (core + any fork-registered flags). */
  const KNOWN_FEATURES = getAllFeatureFlags().map((f) => ({ id: f.key, label: f.label, description: f.description }));

  const openFeatureAssign = useCallback(async (user: ManagedUser) => {
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
  }, []);

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

  // ─── Schema ──────────────────────────────────────────
  const schema = useMemo(
    () =>
      defineCrud<UserRow>({
        name: 'settings.users',
        icon: Users,
        idField: 'id',
        testId: 'users',
        dataSource,
        pageSize: 200,
        emptyMessage: t('settings.noUsersFound'),
        formMode: 'dialog',
        formTitle: (mode) => (mode === 'add' ? t('settings.addNewUser') : t('settings.editUser')),
        columns: [
          {
            key: 'nickname',
            label: 'User',
            type: 'custom',
            render: (u) => (
              <div className="flex items-center gap-2.5">
                <span
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0 ${
                    u.role === 'super' || u.role === 'team'
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
            ),
          },
          {
            key: 'role',
            label: 'Role',
            type: 'custom',
            render: (u) => (
              <Tag tone={ROLE_TONE[u.role] ?? 'neutral'} className="capitalize">
                {u.role}
              </Tag>
            ),
          },
          {
            key: 'status',
            label: 'Status',
            type: 'toggle',
            align: 'center',
            width: '80px',
            checked: (u) => u.status === 'active',
            disabled: (u) => u.role === 'super',
            onToggle: async (u, next) => {
              const res = await authFetch(`/api/admin/users/${u.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ status: next ? 'active' : 'disabled' }),
              });
              if (!res.ok) {
                const err = await res.json().catch(() => null);
                throw new Error(err?.error || t('common.operationFailed'));
              }
            },
          },
          {
            key: 'today_messages',
            label: 'Today Msgs',
            type: 'custom',
            align: 'right',
            render: (u) => {
              const usage = u.usage_summary;
              if (!usage) return <span className="text-xs text-fg-faint">—</span>;
              const msgPct =
                u.daily_message_limit > 0 ? Math.min(100, (usage.today_messages / u.daily_message_limit) * 100) : 0;
              return (
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
              );
            },
          },
          {
            key: 'month_tokens',
            label: 'Month Tokens',
            type: 'custom',
            align: 'right',
            sortable: true,
            render: (u) => {
              const usage = u.usage_summary;
              if (!usage) return <span className="text-xs text-fg-faint">—</span>;
              const tokenPct =
                u.monthly_token_limit > 0 ? Math.min(100, (usage.month_tokens / u.monthly_token_limit) * 100) : 0;
              return (
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
              );
            },
          },
          {
            key: 'total_calls',
            label: 'Total Calls',
            type: 'custom',
            align: 'right',
            sortable: true,
            render: (u) => (
              <span className="text-xs font-medium text-fg-secondary">
                {u.usage_summary ? u.usage_summary.total_calls.toLocaleString() : '—'}
              </span>
            ),
          },
          {
            key: 'last_login_at',
            label: 'Last Login',
            type: 'custom',
            align: 'right',
            sortable: true,
            render: (u) => (
              <span className="text-xs text-fg-faint">
                {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString('zh-CN') : t('common.neverLoggedIn')}
              </span>
            ),
          },
        ],
        filters: [
          { key: 'email', label: t('settings.searchUsers'), kind: 'text', placeholder: t('settings.searchUsers') },
          {
            key: 'role',
            label: t('settings.filterByRole'),
            kind: 'select',
            options: [
              { value: 'super', label: 'Super' },
              { value: 'team', label: 'Team' },
              { value: 'external', label: 'External' },
            ],
          },
          {
            key: 'status',
            label: t('settings.filterByStatus'),
            kind: 'select',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'disabled', label: 'Disabled' },
            ],
          },
        ],
        formFields: [
          {
            key: 'email',
            label: t('settings.emailPlaceholder'),
            type: 'email',
            width: 2,
            required: true,
            placeholder: t('settings.emailPlaceholder'),
            allows: { edit: false },
          },
          {
            key: 'password',
            label: t('settings.passwordPlaceholder'),
            type: 'password',
            width: 2,
            required: true,
            placeholder: t('settings.passwordPlaceholder'),
            allows: { edit: false },
            rules: [{ validate: (v) => (String(v ?? '').length < 8 ? t('settings.passwordMinLength') : null) }],
          },
          {
            key: 'nickname',
            label: t('common.nickname'),
            type: 'text',
            width: 2,
            required: true,
            placeholder: t('settings.nicknamePlaceholder'),
          },
          {
            key: 'role',
            label: t('common.role'),
            type: 'select',
            width: 2,
            defaultValue: 'team',
            disabled: (form) => form.role === 'super',
            options: [
              { value: 'team', label: 'Team' },
              { value: 'external', label: 'External' },
            ],
          },
          {
            key: 'daily_message_limit',
            label: t('settings.dailyMsgLimit'),
            type: 'number',
            width: 2,
            defaultValue: 50,
          },
          {
            key: 'monthly_token_limit',
            label: t('settings.monthlyTokenLimit'),
            type: 'number',
            width: 2,
            defaultValue: 5000000,
          },
        ],
        access: {
          canView: false,
          canAdd: true,
          canEdit: true,
          canDelete: true,
          canEditRow: (row) => row.role !== 'super',
          canDeleteRow: (row) => row.role !== 'super',
        },
        tableActions: [
          {
            key: 'tools',
            label: t('settings.toolAssignment'),
            icon: Wrench,
            visible: (u) => u.role !== 'super',
            onClick: (u) => openToolAssign(u),
          },
          {
            key: 'features',
            label: 'Feature Toggles',
            icon: Sparkles,
            onClick: (u) => openFeatureAssign(u),
          },
          {
            key: 'reset-password',
            label: t('settings.resetPassword'),
            icon: Key,
            tone: 'warning',
            visible: (u) => u.role !== 'super',
            onClick: (u) => handleResetPassword(u.id),
          },
          {
            key: 'profiles',
            label: 'Assign Profiles',
            icon: Bot,
            visible: (u) => u.role !== 'super',
            onClick: (u) => openProfileAssign(u),
          },
        ],
      }),
    [t, dataSource, openToolAssign, openFeatureAssign, openProfileAssign, handleResetPassword],
  );

  return (
    <>
      <CrudPage schema={schema} />

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
              {/* Super-category tools are super-admin-only and never user-assignable,
                  so they're intentionally omitted from the assignment picker. */}
              {(['public', 'team'] as const).map((cat) => {
                const catTools = allTools.filter((t) => t.category === cat);
                if (catTools.length === 0) return null;
                return (
                  <div key={cat} className="mb-2">
                    <div className="px-1 pt-2 pb-1">
                      <span className="text-[10px] font-semibold text-fg-faint uppercase tracking-wider">
                        {cat === 'public' ? t('settings.publicGlobal') : 'Team'}
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
                        .map((tool) => {
                          const isGlobal = tool.is_global;
                          const isAssigned = isGlobal || assignedToolIds.has(tool.id);
                          const Icon = getToolIcon(tool.id);
                          return (
                            <button
                              key={tool.id}
                              onClick={() => !isGlobal && handleToggleToolAssign(tool.id)}
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
                                  {tool.name}
                                </span>
                                <span className="text-[11px] text-fg-faint ml-2">{tool.brief}</span>
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
    </>
  );
}
