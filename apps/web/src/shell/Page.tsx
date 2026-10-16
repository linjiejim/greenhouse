/**
 * A page: one 56 header (title, an optional "?", a status badge, at most one primary action and
 * a "⋯") over the page's single scroll area (layout.md). In the narrow layout the header opens
 * the directory on the left and notifications on the right.
 */

import type { ReactNode } from 'react';
import { Bell, Menu as MenuIcon, PanelLeftOpen } from 'lucide-react';
import { HelpHint, IconButton, Menu, type MenuEntry } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useNotificationSummary } from '../data/notifications';
import { cx } from '../lib/cx';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';
import { useShell } from './context';

export type PageWidth = 'reading' | 'form' | 'list' | 'canvas';

export function PageHeader({
  title,
  wrap = false,
  leading,
  help,
  badge,
  actions,
  primary,
  menu,
}: {
  title: ReactNode;
  /** Let rich object headings and their actions wrap on a narrow screen. */
  wrap?: boolean;
  /** Before the title: an avatar on a conversation, a back button on a detail. */
  leading?: ReactNode;
  help?: ReactNode;
  badge?: ReactNode;
  /** Icon buttons that belong to the object (computer, info). */
  actions?: ReactNode;
  primary?: ReactNode;
  menu?: MenuEntry[];
}) {
  const t = useT();
  const { narrow, directoryHidden, openDirectory } = useShell();
  const summary = useNotificationSummary();
  const unread = summary.data?.unread ?? 0;
  return (
    <header className={cx('app-page-header', wrap && 'is-wrap')}>
      {directoryHidden && (
        <IconButton label={narrow ? t('nav.menu') : t('nav.openDirectory')} onClick={openDirectory}>
          {narrow ? (
            <MenuIcon size={icon.lg} strokeWidth={icon.stroke} />
          ) : (
            <PanelLeftOpen size={icon.md} strokeWidth={icon.stroke} />
          )}
        </IconButton>
      )}
      {leading}
      <h1 className="app-page-title">{title}</h1>
      {help && typeof title === 'string' && <HelpHint label={title}>{help}</HelpHint>}
      {badge}
      <span className="app-page-header-spacer" />
      {actions}
      {primary}
      {menu && menu.length > 0 && <Menu items={menu} />}
      {narrow && (
        <span className="app-header-notifications">
          <IconButton label={t('nav.notifications')} onClick={() => navigate({ page: 'notifications' })}>
            <Bell size={icon.lg} strokeWidth={icon.stroke} />
          </IconButton>
          {unread > 0 && <span className="app-rail-dot" aria-label={t('nav.unread')} />}
        </span>
      )}
    </header>
  );
}

/** The header and the one scroll area, with the content width of the page's kind. */
export function Page({
  header,
  width = 'list',
  scroll = true,
  children,
  className,
}: {
  header: ReactNode;
  width?: PageWidth;
  /** False when the page brings its own scroll area (a conversation: thread above, composer below). */
  scroll?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx('app-page', className)}>
      {header}
      {scroll ? (
        <div className="app-page-scroll">
          <div className={cx('app-page-body', `is-${width}`)}>{children}</div>
        </div>
      ) : (
        children
      )}
    </div>
  );
}
