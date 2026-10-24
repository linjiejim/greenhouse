/**
 * Opening a notification from the notifications sheet or a push tap: when it points at something
 * with a screen here — a document, a file, a project or task, a table record, a conversation,
 * My Agents (src/lib/deep-links.ts `notificationTarget`) — that opens straight away and the
 * notification is read (its banner goes once the server has it read, src/data/read-on-open.ts);
 * otherwise its own sheet opens, which offers the web page it points at.
 */

import { readOnOpen } from '../data/read-on-open';
import { notificationTarget, type AppTarget } from '../lib/deep-links';
import { t } from '../lib/i18n';
import { clearReadBanners } from '../push/handler';
import { useNotifications } from '../store/notifications';
import { getApiBase } from '../store/stations';
import { alertError } from '../ui/dialogs';
import type { ObjectRef } from './object-ref';

export async function openNotificationOrTarget(
  id: string,
  open: { object: (ref: ObjectRef) => void; target: (target: AppTarget) => void },
): Promise<void> {
  const store = useNotifications.getState();
  const known = store.items.find((item) => item.id === id);
  const target = known ? notificationTarget(known, getApiBase()) : null;
  const native = target && (target.kind !== 'web' || /^#\/activity\//.test(target.hash)) && target.kind !== 'external';
  if (!target || !native) {
    open.object({ kind: 'notification', id });
    return;
  }
  open.target(target);
  await readOnOpen(id, {
    known,
    markRead: (target) => store.markRead(target),
    fetchByReading: (target) => store.open(target),
    clearBanner: (target) => clearReadBanners({ readIds: [target] }),
    reportFailure: () => alertError(t('notifications.markFailed')),
  });
}
