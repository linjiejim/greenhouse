import React, { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, EmptyState, Spinner } from '../../components/ui';
import { Check, Inbox } from '../../lib/icons';
import { listTableNotifications, markTableNotificationRead, type TableNotification } from '../../lib/api/tables';
import { formatDate } from '../../lib/utils';
import { useT } from '../../lib/i18n';

export function TablesNotificationsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const [notifications, setNotifications] = useState<TableNotification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setNotifications(await listTableNotifications());
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.notificationsLoadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const markRead = async (notification: TableNotification) => {
    try {
      const updated = await markTableNotificationRead(notification.id);
      setNotifications((current) => current.map((entry) => (entry.id === updated.id ? updated : entry)));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.notificationUpdateFailed'));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.tableNotifications')} size="lg">
      <div className="space-y-3">
        {error && <p className="rounded-md bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
        {loading ? (
          <div className="flex justify-center py-12">
            <Spinner />
          </div>
        ) : notifications.length === 0 ? (
          <EmptyState
            icon={Inbox}
            variant="compact"
            tone="neutral"
            title={t('tables.noNotifications')}
            description={t('tables.notificationsHint')}
          />
        ) : (
          <div className="divide-y divide-edge rounded-lg border border-edge">
            {notifications.map((notification) => (
              <div
                key={notification.id}
                className={`flex gap-3 px-3 py-3 ${notification.read_at ? '' : 'bg-primary-subtle/40'}`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-sm font-medium text-fg">{notification.title}</p>
                    {!notification.read_at && (
                      <span className="h-2 w-2 rounded-full bg-primary" aria-label={t('tables.unread')} />
                    )}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-5 text-fg-muted">{notification.message}</p>
                  <p className="mt-1 text-[11px] text-fg-faint">{formatDate(notification.created_at)}</p>
                </div>
                {!notification.read_at && (
                  <Button variant="ghost" size="sm" onClick={() => void markRead(notification)}>
                    <Check size={13} className="mr-1.5" />
                    {t('tables.markRead')}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
