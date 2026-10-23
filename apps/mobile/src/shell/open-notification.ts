/**
 * Opening a notification from a Home row or a push tap: when it points at something with a screen
 * here — a document, a file, a project or task, a table record, a conversation, My Agents
 * (src/lib/deep-links.ts `notificationTarget`) — that screen opens straight away and the
 * notification is read (its banner goes once the server has it read, src/data/read-on-open.ts);
 * otherwise its own page opens (/notification), which offers the web page it points at.
 */

import type { useRouter } from 'expo-router';
import { readOnOpen } from '../data/read-on-open';
import { notificationTarget } from '../lib/deep-links';
import { t } from '../lib/i18n';
import { clearReadBanners } from '../push/handler';
import { useNotifications } from '../store/notifications';
import { getApiBase } from '../store/stations';
import { alertError } from '../ui/dialogs';
import { openNotification } from './nav';
import { openTarget } from './open-target';

type Router = ReturnType<typeof useRouter>;

export async function openNotificationOrTarget(router: Router, id: string, accent?: string): Promise<void> {
  const store = useNotifications.getState();
  const known = store.items.find((item) => item.id === id);
  const target = known ? notificationTarget(known, getApiBase()) : null;
  if (!target || target.kind === 'web' || target.kind === 'external') {
    openNotification(router, id);
    return;
  }
  openTarget(router, target, accent);
  await readOnOpen(id, {
    known,
    markRead: (target) => store.markRead(target),
    fetchByReading: (target) => store.open(target),
    clearBanner: (target) => clearReadBanners({ readIds: [target] }),
    reportFailure: () => alertError(t('notifications.markFailed')),
  });
}
