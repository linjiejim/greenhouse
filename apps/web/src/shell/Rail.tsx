/**
 * The 64px global rail (PRD §6.1): the mark (back to the main thread), the modules, then runs,
 * notifications and the account. Module buttons have a right-click menu of "new" actions.
 */

import type { ReactNode } from 'react';
import { CheckCheck, Hash, LogOut, Plus, Settings, Shield, Sparkles, type LucideIcon } from 'lucide-react';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { Menu, Tooltip, useContextMenu, useTooltip, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useSession } from '../app/session';
import { useConversations, useMarkRead } from '../data/conversations';
import { useNotificationSummary, useMarkNotificationsRead } from '../data/notifications';
import { useRuns } from '../data/runs';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { MODULES, type ModuleId } from './modules';
import { useOpenOverlay } from './overlays';
import { useShell } from './context';
import { MemberAvatar } from './MemberAvatar';

const glyph = (Icon: LucideIcon) => <Icon size={icon.md} strokeWidth={icon.stroke} />;

function RailButton({
  id,
  active,
  badge,
  menu,
  onClick,
}: {
  id: ModuleId;
  active: boolean;
  badge?: ReactNode;
  menu?: MenuEntry[];
  onClick: () => void;
}) {
  const t = useT();
  const label = t(MODULES[id].label);
  const context = useContextMenu(menu ?? [], t('nav.quickActions', { name: label }));
  const tip = useTooltip(label, { side: 'right' });
  const Icon = MODULES[id].icon;
  return (
    <>
      <button
        type="button"
        className="app-rail-item"
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        {...tip.bind({ ...(menu ? context.handlers : {}), onClick })}
      >
        <Icon size={icon.lg} strokeWidth={icon.stroke} />
        {badge}
      </button>
      {tip.tooltip}
      {context.menu}
    </>
  );
}

export function Rail({ module }: { module: ModuleId }) {
  const t = useT();
  const { me, signOut } = useSession();
  const { openPalette } = useShell();
  const openOverlay = useOpenOverlay();
  const summary = useNotificationSummary();
  const active = useRuns('active');
  const conversations = useConversations();
  const markRead = useMarkRead();
  const markNotifications = useMarkNotificationsRead();
  const needsYou = summary.data?.needs_you ?? 0;
  const unread = summary.data?.unread ?? 0;

  const markAllRead = () => {
    for (const item of conversations.items) {
      if (item.unread > 0) markRead.mutate({ id: item.id, seq: item.last_seq });
    }
  };

  const chatMenu: MenuEntry[] = [
    { label: t('chat.newChat'), icon: glyph(Plus), onClick: () => navigate('#/c/new') },
    { label: t('chat.newRoom'), icon: glyph(Hash), onClick: () => openOverlay({ type: 'new-room' }) },
    { label: t('agents.new'), icon: glyph(Sparkles), onClick: () => openOverlay({ type: 'new-agent' }) },
    '-',
    { label: t('chat.markAllRead'), icon: glyph(CheckCheck), onClick: markAllRead },
  ];
  const runsMenu: MenuEntry[] = [
    { label: t('runs.active'), onClick: () => navigate({ page: 'runs', view: 'active' }) },
    { label: t('runs.scheduled'), onClick: () => navigate({ page: 'runs', view: 'scheduled' }) },
    { label: t('runs.done'), onClick: () => navigate({ page: 'runs', view: 'done' }) },
  ];
  const notificationsMenu: MenuEntry[] = [
    {
      label: t('notifications.markAllRead'),
      icon: glyph(CheckCheck),
      onClick: () => markNotifications.mutate({ all: true }),
    },
    {
      label: t('notifications.settings'),
      icon: glyph(Settings),
      onClick: () => navigate({ page: 'settings', section: 'notifications' }),
    },
  ];

  return (
    <nav className="app-rail" aria-label={t('nav.main')}>
      <Tooltip label={t('nav.home')} side="right">
        <button type="button" className="app-rail-mark" aria-label={t('nav.home')} onClick={() => navigate('#/c/main')}>
          <GreenhouseMark />
        </button>
      </Tooltip>
      <div className="app-rail-group">
        <RailButton id="chat" active={module === 'chat'} menu={chatMenu} onClick={() => navigate('#/c/main')} />
        <Menu
          className="app-rail-more"
          label={t('nav.more')}
          align="start"
          items={[
            {
              label: t('nav.agents'),
              icon: glyph(Sparkles),
              onClick: () => navigate({ page: 'agents', scope: 'mine' }),
            },
            { label: t('search.placeholder'), shortcut: '⌘K', onClick: openPalette },
          ]}
        />
      </div>
      <div className="app-rail-group app-rail-bottom">
        <RailButton
          id="runs"
          active={module === 'runs'}
          menu={runsMenu}
          onClick={() => navigate({ page: 'runs', view: 'active' })}
          badge={active.items.length > 0 ? <span className="app-rail-dot" aria-label={t('nav.running')} /> : undefined}
        />
        <RailButton
          id="notifications"
          active={module === 'notifications'}
          menu={notificationsMenu}
          onClick={() => navigate({ page: 'notifications', view: 'needs' })}
          badge={
            needsYou > 0 ? (
              <span className="app-rail-count" aria-label={t('nav.needsYou', { count: needsYou })}>
                {needsYou > 99 ? '99+' : needsYou}
              </span>
            ) : unread > 0 ? (
              <span className="app-rail-dot" aria-label={t('nav.unread')} />
            ) : undefined
          }
        />
        <Menu
          className="app-rail-account"
          label={t('nav.account')}
          align="start"
          trigger={me ? <MemberAvatar name={me.name} url={me.avatar_url} size={28} /> : null}
          items={[
            {
              label: t('nav.settings'),
              icon: glyph(Settings),
              onClick: () => navigate({ page: 'settings', section: 'account' }),
            },
            ...(me?.role === 'admin'
              ? [
                  {
                    label: t('nav.admin'),
                    icon: glyph(Shield),
                    onClick: () => navigate({ page: 'admin', section: 'members' }),
                  },
                ]
              : []),
            '-',
            { label: t('nav.signOut'), icon: glyph(LogOut), onClick: () => void signOut() },
          ]}
        />
      </div>
    </nav>
  );
}
