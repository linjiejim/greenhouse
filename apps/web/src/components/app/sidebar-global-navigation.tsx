import { useEffect, useRef } from 'react';

import { ChevronDown, ChevronRight, MoreHorizontal } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import type { ChatWorkspaceView } from '../../stores';
import type { PrimaryNavigation, PrimaryNavigationItem } from '../../platform/navigation';
import { CHAT_WORKSPACE_ITEMS } from '../chat/chat-workspace-navigation';
import { useHoverFlyout } from '../../hooks/use-hover-flyout';

interface SidebarGlobalNavigationProps {
  navigation: PrimaryNavigation;
  route: string;
  chatWorkspaceView: ChatWorkspaceView;
  onSelectChatWorkspace: (view: ChatWorkspaceView) => void;
  onNavigate?: () => void;
  compact?: boolean;
  morePlacement?: 'flyout' | 'inline';
  defaultMoreOpen?: boolean;
  className?: string;
}

const MORE_UTILITY_ITEMS = (['prompts', 'automations', 'agents'] as const).map((id) => {
  const item = CHAT_WORKSPACE_ITEMS.find((candidate) => candidate.id === id)!;
  return {
    ...item,
    route: id === 'prompts' ? 'tasks' : id,
    href: id === 'prompts' ? '#/tasks' : `#/${id}`,
  };
});

function directItemClasses(active: boolean, compact: boolean): string {
  return compact
    ? `relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
        active ? 'sidebar-active-item' : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
      }`
    : `flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs font-medium transition-colors md:min-h-8 ${
        active ? 'sidebar-active-item font-semibold' : 'text-fg-muted hover:bg-surface-muted hover:text-fg'
      }`;
}

function PrimaryLink({
  item,
  active,
  compact,
  onNavigate,
}: {
  item: PrimaryNavigationItem;
  active: boolean;
  compact: boolean;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;
  return (
    <a
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={directItemClasses(active, compact)}
      title={item.label}
    >
      <Icon
        size={compact ? 16 : 14}
        className={`flex-shrink-0 ${active ? 'text-primary-fg' : ''}`}
        aria-hidden="true"
      />
      {!compact && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
      {!!item.badge && (
        <span
          className={`${compact ? 'absolute -right-1 -top-1' : ''} inline-flex min-w-4 items-center justify-center rounded-full bg-warning-subtle px-1 text-[9px] font-semibold text-warning`}
        >
          {item.badge > 99 ? '99+' : item.badge}
        </span>
      )}
    </a>
  );
}

export function SidebarGlobalNavigation({
  navigation,
  route,
  chatWorkspaceView,
  onSelectChatWorkspace,
  onNavigate,
  compact = false,
  morePlacement = 'flyout',
  defaultMoreOpen = false,
  className = '',
}: SidebarGlobalNavigationProps) {
  const t = useT();
  const {
    open: moreOpen,
    setOpen: setMoreOpen,
    openNow: openMore,
    closeNow: closeMore,
    closeSoon: closeMoreSoon,
  } = useHoverFlyout({ defaultOpen: defaultMoreOpen });
  const moreRef = useRef<HTMLDivElement>(null);
  const hoverEnabled = morePlacement === 'flyout';
  const utilityMoreActive = MORE_UTILITY_ITEMS.some((item) => item.route === route);
  const overflowActive = navigation.overflow.some((item) => item.key === route);
  const moreActive = utilityMoreActive || overflowActive;

  useEffect(() => {
    if (!moreOpen) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) closeMore();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeMore();
    };
    document.addEventListener('mousedown', closeOnOutsidePress);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [closeMore, moreOpen]);

  const directPrimaryActive = (item: PrimaryNavigationItem) => {
    if (item.key === 'chat') return route === 'chat' && chatWorkspaceView === 'conversation';
    return item.key === route;
  };

  return (
    <nav
      className={`${compact ? 'flex flex-col items-center gap-1' : 'flex flex-col gap-0.5 px-3'} ${className}`}
      aria-label={t('navigation.main')}
    >
      {navigation.primary.map((item) => (
        <PrimaryLink
          key={item.key}
          item={item}
          active={directPrimaryActive(item)}
          compact={compact}
          onNavigate={() => {
            if (item.key === 'chat') onSelectChatWorkspace('conversation');
            onNavigate?.();
          }}
        />
      ))}

      <div
        ref={moreRef}
        className={`relative ${compact ? '' : 'w-full'}`}
        onMouseEnter={hoverEnabled ? openMore : undefined}
        onMouseLeave={hoverEnabled ? closeMoreSoon : undefined}
      >
        <button
          type="button"
          onClick={() => setMoreOpen((open) => !open)}
          className={directItemClasses(moreActive, compact)}
          aria-haspopup="menu"
          aria-expanded={moreOpen}
          aria-current={moreActive ? 'page' : undefined}
          title={t('navigation.more')}
        >
          <MoreHorizontal size={compact ? 16 : 14} className="flex-shrink-0" aria-hidden="true" />
          {!compact && (
            <>
              <span className="min-w-0 flex-1 truncate">{t('navigation.more')}</span>
              {morePlacement === 'flyout' ? (
                <ChevronRight size={13} className="flex-shrink-0" aria-hidden="true" />
              ) : (
                <ChevronDown
                  size={13}
                  className={`flex-shrink-0 transition-transform ${moreOpen ? 'rotate-180' : ''}`}
                  aria-hidden="true"
                />
              )}
            </>
          )}
        </button>

        {moreOpen && (
          <div
            role="menu"
            className={
              morePlacement === 'flyout'
                ? 'absolute left-full top-0 z-40 pl-1 animate-fade-in'
                : 'ml-4 mt-1 border-l border-edge pl-2'
            }
          >
            <div
              className={
                morePlacement === 'flyout'
                  ? 'w-48 max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-edge bg-surface-raised py-1 shadow-lg'
                  : ''
              }
            >
              {MORE_UTILITY_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = route === item.route;
                return (
                  <a
                    key={item.id}
                    href={item.href}
                    role="menuitem"
                    onClick={() => {
                      setMoreOpen(false);
                      onNavigate?.();
                    }}
                    aria-current={active ? 'page' : undefined}
                    className={`flex min-h-11 w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors md:min-h-9 ${
                      active ? 'sidebar-active-item font-semibold' : 'text-fg-secondary hover:bg-surface-muted'
                    }`}
                  >
                    <Icon
                      size={15}
                      className={`flex-shrink-0 ${active ? 'text-primary-fg' : 'text-fg-faint'}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">{t(item.labelKey)}</span>
                  </a>
                );
              })}

              {MORE_UTILITY_ITEMS.length > 0 && navigation.overflow.length > 0 && (
                <div className="mx-2 my-1 border-t border-edge" />
              )}

              {navigation.overflow.map((item) => {
                const Icon = item.icon;
                const active = route === item.key;
                return (
                  <a
                    key={item.key}
                    href={item.href}
                    role="menuitem"
                    aria-current={active ? 'page' : undefined}
                    onClick={() => {
                      setMoreOpen(false);
                      onNavigate?.();
                    }}
                    className={`flex min-h-11 items-center gap-2.5 px-3 py-1.5 text-sm transition-colors md:min-h-9 ${
                      active ? 'sidebar-active-item font-semibold' : 'text-fg-secondary hover:bg-surface-muted'
                    }`}
                  >
                    <Icon
                      size={15}
                      className={`flex-shrink-0 ${active ? 'text-primary-fg' : 'text-fg-faint'}`}
                      aria-hidden="true"
                    />
                    <span className="truncate">{item.label}</span>
                    {!!item.badge && (
                      <span className="ml-auto inline-flex min-w-4 items-center justify-center rounded-full bg-warning-subtle px-1 text-[9px] font-semibold text-warning">
                        {item.badge > 99 ? '99+' : item.badge}
                      </span>
                    )}
                  </a>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </nav>
  );
}
