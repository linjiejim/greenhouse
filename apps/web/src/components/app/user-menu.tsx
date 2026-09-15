/** Sidebar account menu and its account/inbox dialogs. */

import React, { useEffect, useState } from 'react';
import {
  Settings as SettingsIcon,
  ArrowLeft,
  Inbox,
  Users,
  Shield,
  RefreshCw,
  ScrollText,
  Monitor,
  Moon,
  Sun,
} from '../../lib/icons';
import { Avatar, Badge, Dialog, EmptyState, Spinner, StatusDot, toast } from '../ui';
import type { AuthenticatedUser } from '../../lib/auth';
import { isDesktop } from '../../lib/desktop/bridge';
import { checkForWebUpdateManually } from '../../lib/desktop/updates';
import { APP_VERSION, roleBadgeStyles } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import { useDesktopUpdateStore, useWsStore } from '../../stores';
import { InboxModal } from './inbox-modal';
import { useHoverFlyout } from '../../hooks/use-hover-flyout';
import { applyTheme, getActiveTheme, type ThemeKey } from '../../lib/theme';
import { ExecutionCenterLink } from './execution-center-link';

// ─── Sidebar Account Menu ────────────────────────────────

function isTouchLike(): boolean {
  if (typeof window === 'undefined') return false;
  return window.matchMedia?.('(hover: none)').matches || navigator.maxTouchPoints > 0;
}

export function SidebarAccountMenu({
  user,
  compact = false,
  showSettingsIcon = false,
  settingsActive = false,
  executionCenterActive = false,
  onNavigate,
  onBackFromSettings,
  isSettingsRoute = false,
}: {
  user: AuthenticatedUser | null | undefined;
  compact?: boolean;
  showSettingsIcon?: boolean;
  settingsActive?: boolean;
  executionCenterActive?: boolean;
  onNavigate?: () => void;
  onBackFromSettings?: () => void;
  isSettingsRoute?: boolean;
}) {
  const t = useT();
  const { open, setOpen, openNow, closeNow, closeSoon } = useHoverFlyout();
  const [inboxOpen, setInboxOpen] = useState(false);
  const [onlineOpen, setOnlineOpen] = useState(false);
  const [activeTheme, setActiveTheme] = useState<ThemeKey>(() =>
    typeof window === 'undefined' ? 'system' : getActiveTheme(),
  );
  const ref = React.useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) setActiveTheme(getActiveTheme());
  }, [open]);

  const isSuper = user?.role === 'super';
  const shareCount = useWsStore((s) => s.shareCount);
  const notificationCount = useWsStore((s) => s.notificationCount);
  const onlineUsers = useWsStore((s) => s.onlineUsers);
  const wsConnected = useWsStore((s) => s.status === 'connected');
  const checkingForUpdate = useDesktopUpdateStore((s) => s.checking);
  const setReleaseNotesOpen = useDesktopUpdateStore((s) => s.setReleaseNotesOpen);
  const desktop = isDesktop();
  const totalInboxCount = shareCount + notificationCount;
  const showInboxBadge = totalInboxCount > 0;

  const goSettings = () => {
    setOpen(false);
    onNavigate?.();
    window.location.hash = '#/settings/preferences';
  };

  const goAdministration = () => {
    setOpen(false);
    onNavigate?.();
    window.location.hash = '#/administration/users';
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
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) closeNow();
  };

  return (
    <div
      ref={ref}
      className="relative min-w-0"
      onMouseEnter={openNow}
      onMouseLeave={closeSoon}
      onFocusCapture={openNow}
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
              {totalInboxCount > 99 ? '99+' : totalInboxCount}
            </span>
          )}
        </span>
        {!compact && (
          <>
            <div className="flex flex-col min-w-0 flex-1 text-left">
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className={`text-sm truncate ${settingsActive ? 'text-primary-fg-strong' : 'text-fg-secondary'}`}
                  title={user?.nickname || t('common.user')}
                >
                  {user?.nickname || t('common.user')}
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
          className={`absolute z-50 bg-surface-raised border border-edge rounded-xl shadow-xl overflow-hidden animate-fade-in ${
            compact
              ? 'bottom-full left-0 w-72 max-w-[calc(100vw-2rem)]'
              : 'bottom-full left-0 w-[calc(100cqw-1.5rem)] max-w-[calc(100cqw-1.5rem)]'
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
                    className={`text-[10px] px-1.5 py-0.5 rounded-full border font-medium capitalize flex-shrink-0 ${roleBadgeStyles[user.role] || roleBadgeStyles.team}`}
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

          <div className="border-b border-edge px-2.5 py-2">
            <div className="mb-1.5 px-0.5 text-[10px] font-medium uppercase tracking-wider text-fg-faint">
              {t('preferences.theme')}
            </div>
            <div className="grid grid-cols-3 gap-1" role="group" aria-label={t('preferences.theme')}>
              {(
                [
                  ['system', Monitor, t('preferences.themeSystem')],
                  ['dark', Moon, t('preferences.themeDark')],
                  ['light', Sun, t('preferences.themeLight')],
                ] as const
              ).map(([theme, Icon, label]) => {
                const selected = activeTheme === theme;
                return (
                  <button
                    key={theme}
                    type="button"
                    role="menuitemradio"
                    aria-checked={selected}
                    aria-label={label}
                    title={label}
                    onClick={() => {
                      applyTheme(theme);
                      setActiveTheme(theme);
                    }}
                    className={`flex h-8 min-w-0 items-center justify-center rounded-lg transition-colors ${
                      selected
                        ? 'bg-primary-subtle text-primary-fg-strong ring-1 ring-primary-edge'
                        : 'text-fg-muted hover:bg-surface-sunken hover:text-fg-secondary'
                    }`}
                  >
                    <Icon size={14} />
                  </button>
                );
              })}
            </div>
          </div>

          <div className="py-0.5">
            {/* Inbox — opens the shares modal */}
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
              {totalInboxCount > 0 && (
                <span className="min-w-[18px] h-[18px] px-1 flex items-center justify-center text-[10px] font-bold text-white bg-danger rounded-full">
                  {totalInboxCount > 99 ? '99+' : totalInboxCount}
                </span>
              )}
            </button>

            <ExecutionCenterLink
              active={executionCenterActive}
              menu
              onNavigate={() => {
                setOpen(false);
                onNavigate?.();
              }}
            />

            {/* Release notes are part of the product, not a shell-only feature. */}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setReleaseNotesOpen(true);
              }}
              className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-sunken transition-colors"
              role="menuitem"
            >
              <span className="w-5 text-center text-fg-faint">
                <ScrollText size={15} />
              </span>
              <span>{t('desktop.releaseNotes')}</span>
            </button>

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

            {/* Administration — super only, global management surface */}
            {isSuper && (
              <button
                type="button"
                onClick={goAdministration}
                className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-sunken transition-colors"
                role="menuitem"
              >
                <span className="w-5 text-center text-fg-faint">
                  <Shield size={15} />
                </span>
                <span>{t('app.administration')}</span>
              </button>
            )}

            {desktop && (
              <>
                <div className="mx-3 my-1 border-t border-edge" />
                <button
                  type="button"
                  disabled={checkingForUpdate}
                  onClick={() => {
                    setOpen(false);
                    void checkForWebUpdateManually().catch((err) =>
                      toast(err instanceof Error ? err.message : String(err), 'error'),
                    );
                  }}
                  className="w-full text-left flex items-center gap-2.5 px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-sunken transition-colors disabled:opacity-50"
                  role="menuitem"
                >
                  <span className="w-5 text-center text-fg-faint">
                    {checkingForUpdate ? <Spinner /> : <RefreshCw size={15} />}
                  </span>
                  <span>{t('desktop.checkUpdates')}</span>
                </button>
              </>
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

      <InboxModal open={inboxOpen} onClose={() => setInboxOpen(false)} />

      {isSuper && (
        <Dialog
          open={onlineOpen}
          onClose={() => setOnlineOpen(false)}
          title={t('userMenu.onlineUsersTitle', { count: onlineUsers.length })}
          size="sm"
        >
          {onlineUsers.length === 0 ? (
            <EmptyState icon={Users} variant="compact" tone="neutral" title={t('userMenu.noOnlineUsers')} />
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
