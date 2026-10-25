/**
 * The bell — the one entry to the inbox (notifications, shared conversations,
 * team activity). Sits beside Search in the sidebar header; its badge is the
 * same server-pushed unread count the dialog shows (shares + notifications).
 */

import { IconButton } from '../ui';
import { Bell } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { useUIStore, useWsStore } from '../../stores';

export function InboxBellButton() {
  const t = useT();
  const unread = useWsStore((s) => s.shareCount + s.notificationCount);
  const inboxOpen = useUIStore((s) => s.inboxOpen);
  const openInbox = useUIStore((s) => s.openInbox);
  const label = unread > 0 ? t('inbox.bellUnread', { count: unread }) : t('inbox.bell');

  return (
    <span className="relative inline-flex">
      <IconButton
        label={label}
        tooltip="bottom"
        onClick={() => openInbox()}
        className={inboxOpen ? 'bg-primary-subtle text-primary-fg-strong' : ''}
      >
        <Bell size={16} />
      </IconButton>
      {unread > 0 && (
        <span
          aria-hidden="true"
          data-testid="inbox-bell-badge"
          className="pointer-events-none absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-caption font-bold leading-none text-white"
        >
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </span>
  );
}
