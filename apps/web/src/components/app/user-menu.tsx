/**
 * 用户菜单相关组件 — 头像下拉菜单、健康指示器、个人资料面板。
 */

import React, { useState, useEffect } from 'react';
import {
  LogOut,
  ChevronDown,
  ChevronUp,
  Settings as SettingsIcon,
  BarChart3,
  ArrowLeft,
  Inbox,
  Users,
} from '../../lib/icons';
import type { LucideIcon } from '../../lib/icons';
import { Avatar, Badge, Dialog, StatusDot } from '../ui';
import { authFetch } from '../../lib/auth';
import { apiUrl } from '../../lib/api-base';
import type { AuthenticatedUser } from '../../lib/auth';
import { APP_VERSION, roleBadgeStyles } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import { useWsStore } from '../../stores';
import { InboxModal } from './inbox-modal';

export { roleBadgeStyles };

// ─── Health Indicator ────────────────────────────────────

export function HealthIndicator() {
  const t = useT();
  const [status, setStatus] = useState<'ok' | 'error' | 'checking'>('checking');
  const [info, setInfo] = useState<{ sources?: number; model?: string }>({});

  useEffect(() => {
    const check = () => {
      fetch(apiUrl('/health'))
        .then((r) => r.json())
        .then((d) => {
          setStatus('ok');
          setInfo(d);
        })
        .catch(() => setStatus('error'));
    };
    check();
    const interval = setInterval(check, 30000);
    return () => clearInterval(interval);
  }, []);

  const colors = { ok: 'bg-success', error: 'bg-danger', checking: 'bg-warning' };
  const titles = {
    ok: t('health.connected', { model: info.model || '', pages: info.sources || 0 }),
    error: t('health.unreachable'),
    checking: t('health.checking'),
  };

  return (
    <span className="flex items-center gap-1.5" title={titles[status]}>
      <span className={`w-1.5 h-1.5 rounded-full ${colors[status]} ${status === 'checking' ? 'animate-pulse' : ''}`} />
      <span className="text-[10px] text-fg-faint font-mono">v{APP_VERSION}</span>
    </span>
  );
}

// ─── User Menu Dropdown ──────────────────────────────────

export function UserMenuDropdown({
  user,
  menuItems,
  onSignOut,
}: {
  user: AuthenticatedUser;
  menuItems: Array<{ label: string; icon: LucideIcon; onClick: () => void; divider?: boolean }>;
  onSignOut: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-2 px-2 py-1.5 rounded-lg text-sm transition-colors ${
          open ? 'bg-surface-muted' : 'hover:bg-surface-sunken'
        }`}
      >
        {/* Avatar */}
        <Avatar name={user.nickname} size="sm" variant="primary" />
        {/* Nickname + role badge */}
        <span className="hidden md:flex items-center gap-1.5">
          <span className="text-sm text-fg-secondary font-medium">{user.nickname}</span>
        </span>
        {/* Chevron */}
        {open ? (
          <ChevronUp size={14} className="text-fg-faint hidden md:block" />
        ) : (
          <ChevronDown size={14} className="text-fg-faint hidden md:block" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-1.5 w-56 bg-surface-raised border border-edge rounded-xl shadow-lg py-1 z-50">
          {/* User info header */}
          <div className="px-3 py-2.5 border-b border-edge">
            <div className="flex items-center gap-2">
              <Avatar name={user.nickname} size="md" variant="primary" />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <div className="text-sm font-medium text-fg truncate">{user.nickname}</div>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium capitalize ${roleBadgeStyles[user.role] || roleBadgeStyles.member}`}
                  >
                    {user.role}
                  </span>
                </div>
                {user.email && <div className="text-xs text-fg-faint truncate">{user.email}</div>}
              </div>
            </div>
          </div>

          {/* Menu items */}
          {menuItems.map((item, idx) => (
            <React.Fragment key={item.label}>
              {item.divider && idx > 0 && <div className="border-t border-edge my-1" />}
              <button
                onClick={() => {
                  item.onClick();
                  setOpen(false);
                }}
                className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-fg-secondary hover:bg-surface-sunken transition-colors"
              >
                <span className="w-5 text-center text-fg-faint">
                  <item.icon size={15} />
                </span>
                <span>{item.label}</span>
              </button>
            </React.Fragment>
          ))}

          {/* Sign out */}
          <div className="border-t border-edge my-1" />
          <button
            onClick={() => {
              onSignOut();
              setOpen(false);
            }}
            className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-danger hover:bg-danger-subtle transition-colors"
          >
            <span className="w-5 text-center">
              <LogOut size={15} />
            </span>
            <span>{t('app.logout')}</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Sidebar Account Menu ────────────────────────────────

type UsageStats = {
  today_messages: number;
  month_tokens: number;
  daily_limit: number | null;
  monthly_limit: number | null;
};

function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`;
  return String(value);
}

function usagePercent(value: number, limit: number | null): number {
  if (!limit || limit <= 0) return 0;
  return Math.min(100, Math.round((value / limit) * 100));
}

function isTouchLike(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(hover: none)').matches || navigator.maxTouchPoints > 0;
}

export function SidebarAccountMenu({
  user,
  compact = false,
  showSettingsIcon = false,
  settingsActive = false,
  onNavigate,
  onBackFromSettings,
  isSettingsRoute = false,
}: {
  user: AuthenticatedUser | null | undefined;
  compact?: boolean;
  showSettingsIcon?: boolean;
  settingsActive?: boolean;
  onNavigate?: () => void;
  onBackFromSettings?: () => void;
  isSettingsRoute?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const isExternal = !user || user.role === 'external';
  const isSuper = user?.role === 'super';
  const shareCount = useWsStore((s) => s.shareCount);
  const onlineUsers = useWsStore((s) => s.onlineUsers);
  const wsConnected = useWsStore((s) => s.status === 'connected');
  const showInboxBadge = !isExternal && shareCount > 0;

  useEffect(() => {
    if (!open || !user || user.role === 'external') return;
    let cancelled = false;
    setUsageLoading(true);
    setUsageError(false);
    authFetch('/api/auth/me/usage')
      .then(async (res) => {
        if (!res.ok) throw new Error(`Usage request failed: ${res.status}`);
        return (await res.json()) as { usage: UsageStats };
      })
      .then((data) => {
        if (!cancelled) setUsage(data.usage);
      })
      .catch(() => {
        if (!cancelled) setUsageError(true);
      })
      .finally(() => {
        if (!cancelled) setUsageLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, user?.id, user?.role]);

  const goSettings = () => {
    setOpen(false);
    onNavigate?.();
    window.location.hash = '#/settings/preferences';
  };

  const handleTriggerClick = (e: React.MouseEvent) => {
    if (isTouchLike()) {
      e.preventDefault();
      setOpen((prev) => !prev);
      return;
    }
    goSettings();
  };

  const handleBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOpen(false);
  };

  const todayPercent = usage ? usagePercent(usage.today_messages, usage.daily_limit) : 0;
  const monthPercent = usage ? usagePercent(usage.month_tokens, usage.monthly_limit) : 0;

  return (
    <div
      ref={ref}
      className="relative min-w-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={handleBlur}
    >
      <button
        onClick={handleTriggerClick}
        className={
          compact
            ? 'flex items-center justify-center hover:opacity-80 transition-opacity'
            : `flex items-center gap-2 w-full min-w-0 rounded-md px-2 py-1 transition-colors ${
                settingsActive ? 'bg-primary-subtle' : 'hover:bg-surface-muted'
              }`
        }
        title={user?.nickname || 'Profile'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        {!compact && isSettingsRoute && onBackFromSettings && (
          <span
            role="button"
            tabIndex={0}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onBackFromSettings();
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.stopPropagation();
                e.preventDefault();
                onBackFromSettings();
              }
            }}
            className="flex-shrink-0 p-0.5 rounded text-fg-faint hover:text-fg-secondary transition-colors cursor-pointer"
            title={t('common.back')}
          >
            <ArrowLeft size={14} />
          </span>
        )}
        <span className="relative flex-shrink-0">
          <Avatar name={user?.nickname} size={compact ? 'md' : 'sm'} />
          {showInboxBadge && (
            <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 flex items-center justify-center text-[10px] font-bold text-white bg-danger rounded-full ring-2 ring-surface-raised">
              {shareCount > 99 ? '99+' : shareCount}
            </span>
          )}
        </span>
        {!compact && (
          <>
            <div className="flex flex-col min-w-0 flex-1 text-left">
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={`text-sm truncate ${settingsActive ? 'text-primary-fg-strong' : 'text-fg-secondary'}`}
                  title={user?.nickname || 'User'}
                >
                  {user?.nickname || 'User'}
                </span>
                {user?.role && (
                  <span className="text-[10px] text-fg-faint leading-tight capitalize flex-shrink-0">{user.role}</span>
                )}
              </div>
              <span className="text-[9px] text-fg-faint font-mono leading-tight">v{APP_VERSION}</span>
            </div>
            {showSettingsIcon && (
              <span
                className={`flex-shrink-0 p-1 rounded transition-colors ${
                  settingsActive ? 'text-primary-fg' : 'text-fg-faint'
                }`}
                aria-hidden="true"
              >
                <SettingsIcon size={15} />
              </span>
            )}
          </>
        )}
      </button>

      {open && user && (
        <div
          role="menu"
          className={`absolute z-50 bottom-full left-0 bg-surface-raised border border-edge rounded-xl shadow-xl overflow-hidden animate-fade-in ${
            compact ? 'w-72 max-w-[calc(100vw-2rem)]' : 'right-0'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-2.5 border-b border-edge bg-surface-sunken">
            <div className="flex items-center gap-2.5">
              <Avatar name={user.nickname} size="md" variant="primary" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-semibold text-fg truncate" title={user.nickname}>
                    {user.nickname}
                  </span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium capitalize flex-shrink-0 ${roleBadgeStyles[user.role] || roleBadgeStyles.member}`}
                  >
                    {user.role}
                  </span>
                </div>
                {user.email && (
                  <div className="text-xs text-fg-faint truncate mt-0.5" title={user.email}>
                    {user.email}
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="p-2.5 border-b border-edge">
            <div className="flex items-center gap-1.5 text-xs font-medium text-fg-secondary mb-1.5">
              <BarChart3 size={13} className="text-fg-faint" />
              <span>{t('userMenu.usageStats')}</span>
            </div>
            {usageLoading && <div className="text-xs text-fg-faint py-2">{t('userMenu.loadingUsage')}</div>}
            {!usageLoading && usageError && (
              <div className="text-xs text-fg-faint py-2">{t('userMenu.usageUnavailable')}</div>
            )}
            {!usageLoading && !usageError && usage && (
              <div className="space-y-2.5">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-fg-muted">{t('userMenu.todayMessages')}</span>
                    <span className="text-fg-secondary font-medium">
                      {usage.today_messages}
                      {usage.daily_limit ? ` / ${usage.daily_limit}` : ''}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary-500" style={{ width: `${todayPercent}%` }} />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-fg-muted">{t('userMenu.monthTokens')}</span>
                    <span className="text-fg-secondary font-medium">
                      {formatTokens(usage.month_tokens)}
                      {usage.monthly_limit ? ` / ${formatTokens(usage.monthly_limit)}` : ''}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-surface-muted overflow-hidden">
                    <div className="h-full rounded-full bg-primary-500" style={{ width: `${monthPercent}%` }} />
                  </div>
                </div>
              </div>
            )}
            {!usageLoading && !usageError && !usage && (
              <div className="text-xs text-fg-faint py-2">{t('userMenu.noUsageData')}</div>
            )}
          </div>

          <div className="py-0.5">
            {/* Inbox — opens the shares modal */}
            {!isExternal && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setInboxOpen(true);
                }}
                className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-sunken transition-colors"
                role="menuitem"
              >
                <span className="w-5 text-center text-fg-faint">
                  <Inbox size={15} />
                </span>
                <span className="flex-1">{t('userMenu.inbox')}</span>
                {shareCount > 0 && (
                  <span className="min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-bold text-white bg-danger rounded-full">
                    {shareCount > 99 ? '99+' : shareCount}
                  </span>
                )}
              </button>
            )}

            {/* Online users — super only, opens a dialog on click */}
            {isSuper && wsConnected && (
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  setOnlineOpen(true);
                }}
                className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-sunken transition-colors"
                role="menuitem"
              >
                <span className="w-5 text-center text-fg-faint">
                  <Users size={15} />
                </span>
                <span className="flex-1">{t('userMenu.onlineUsers')}</span>
                <StatusDot color="success" size="sm" />
                <span className="text-xs text-fg-faint tabular-nums">{onlineUsers.length}</span>
              </button>
            )}

            <button
              type="button"
              onClick={goSettings}
              className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-sunken transition-colors"
              role="menuitem"
            >
              <span className="w-5 text-center text-fg-faint">
                <SettingsIcon size={15} />
              </span>
              <span>{t('app.settings')}</span>
            </button>
          </div>
        </div>
      )}

      {!isExternal && <InboxModal open={inboxOpen} onClose={() => setInboxOpen(false)} />}

      {isSuper && (
        <Dialog
          open={onlineOpen}
          onClose={() => setOnlineOpen(false)}
          title={t('userMenu.onlineUsersTitle', { count: onlineUsers.length })}
          size="sm"
        >
          {onlineUsers.length === 0 ? (
            <div className="py-8 text-center text-sm text-fg-muted">{t('userMenu.noOnlineUsers')}</div>
          ) : (
            <div className="space-y-1 max-h-[60vh] overflow-y-auto">
              {onlineUsers.map((u) => (
                <div key={u.userId} className="flex items-center gap-2.5 px-2 py-2 rounded-lg hover:bg-surface-sunken">
                  <Avatar name={u.nickname} size="sm" />
                  <span className="text-sm text-fg-secondary truncate flex-1" title={u.nickname}>
                    {u.nickname}
                  </span>
                  <Badge variant="secondary" className="text-[10px] flex-shrink-0">
                    {u.role}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Dialog>
      )}
    </div>
  );
}

// ─── My Profile Panel ────────────────────────────────────

export function MyProfilePanel({ user, onSignOut }: { user: AuthenticatedUser; onSignOut?: () => void }) {
  const t = useT();
  const [usage, setUsage] = useState<{
    today_messages: number;
    month_tokens: number;
    daily_limit: number;
    monthly_limit: number;
  } | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch(`/api/admin/users/${user.id}`);
        if (res.ok) {
          const data = await res.json();
          setUsage(data.usage);
        }
      } catch (_err) {
        /* only super can see this anyway */
      }
    })();
  }, [user.id]);

  return (
    <div className="space-y-4">
      {/* Profile card */}
      <div className="flex items-center gap-4 p-4 bg-surface-sunken rounded-xl">
        <Avatar name={user.nickname} size="lg" variant="primary" />
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg font-semibold text-fg">{user.nickname}</span>
            <span
              className={`text-xs px-2 py-0.5 rounded-full border font-medium capitalize ${roleBadgeStyles[user.role] || roleBadgeStyles.member}`}
            >
              {user.role}
            </span>
          </div>
          {user.email && <div className="text-sm text-fg-muted mt-0.5">{user.email}</div>}
        </div>
      </div>

      {/* Usage stats */}
      {usage && (
        <div>
          <h4 className="text-sm font-medium text-fg-secondary mb-2">{t('userMenu.usageStats')}</h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="bg-surface-raised border border-edge rounded-lg p-3">
              <div className="text-xs text-fg-muted">{t('userMenu.todayMessages')}</div>
              <div className="text-xl font-semibold text-fg mt-1">
                {usage.today_messages}
                <span className="text-sm font-normal text-fg-faint"> / {usage.daily_limit}</span>
              </div>
            </div>
            <div className="bg-surface-raised border border-edge rounded-lg p-3">
              <div className="text-xs text-fg-muted">{t('userMenu.monthTokens')}</div>
              <div className="text-xl font-semibold text-fg mt-1">
                {(usage.month_tokens / 1000).toFixed(0)}k
                <span className="text-sm font-normal text-fg-faint">
                  {' '}
                  / {(usage.monthly_limit / 1000000).toFixed(0)}M
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Profiles */}
      {user.profiles && user.profiles.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-fg-secondary mb-2">{t('userMenu.availableProfiles')}</h4>
          <div className="flex flex-wrap gap-2">
            {user.profiles.map((p) => (
              <span
                key={p}
                className="text-xs bg-primary-subtle text-primary-fg-strong px-2.5 py-1 rounded-full border border-primary-edge"
              >
                {p}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Logout */}
      {onSignOut && (
        <div className="pt-2 border-t border-edge">
          <button
            onClick={onSignOut}
            className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-sm text-danger hover:bg-danger-subtle transition-colors"
          >
            <LogOut size={15} />
            <span>{t('app.logout')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
