import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Dialog, EmptyState, Spinner } from '../../components/ui';
import { History } from '../../lib/icons';
import { listTableBaseAudit, type TableAuditEvent } from '../../lib/api/tables';
import { formatDate } from '../../lib/utils';
import { useT, type TranslationKey } from '../../lib/i18n';

interface TablesAuditDialogProps {
  open: boolean;
  baseId: number;
  users: Array<{ id: string; nickname: string; email: string }>;
  onClose: () => void;
}

const ACTION_LABELS: Record<string, TranslationKey> = {
  createBase: 'tables.audit.createBase',
  updateBase: 'tables.audit.updateBase',
  archiveBase: 'tables.audit.archiveBase',
  manageMembers: 'tables.audit.manageMembers',
  createTable: 'tables.audit.createTable',
  updateTable: 'tables.audit.updateTable',
  createField: 'tables.audit.createField',
  updateField: 'tables.audit.updateField',
  archiveField: 'tables.audit.archiveField',
  createView: 'tables.audit.createView',
  updateView: 'tables.audit.updateView',
  createRecord: 'tables.audit.createRecord',
  updateRecord: 'tables.audit.updateRecord',
  batchUpsertRecords: 'tables.audit.batchUpsertRecords',
  deleteRecord: 'tables.audit.deleteRecord',
  createDashboard: 'tables.audit.createDashboard',
  updateDashboard: 'tables.audit.updateDashboard',
  createDashboardWidget: 'tables.audit.createDashboardWidget',
  updateDashboardWidget: 'tables.audit.updateDashboardWidget',
  deleteDashboardWidget: 'tables.audit.deleteDashboardWidget',
  listBaseAudit: 'tables.audit.listBaseAudit',
};

export function TablesAuditDialog({ open, baseId, users, onClose }: TablesAuditDialogProps) {
  const t = useT();
  const [events, setEvents] = useState<TableAuditEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError('');
    listTableBaseAudit(baseId)
      .then(setEvents)
      .catch((loadError) => setError(loadError instanceof Error ? loadError.message : t('tables.audit.loadFailed')))
      .finally(() => setLoading(false));
  }, [baseId, open, t]);

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.audit.title')} size="lg">
      <div className="max-h-[65vh] overflow-y-auto">
        {loading && events.length === 0 ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-6 w-6 text-fg-faint" />
          </div>
        ) : error ? (
          <p className="rounded-md border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>
        ) : events.length === 0 ? (
          <EmptyState
            icon={History}
            variant="compact"
            tone="neutral"
            title={t('tables.audit.empty')}
            description={t('tables.audit.emptyHint')}
          />
        ) : (
          <ol className="divide-y divide-edge">
            {events.map((event) => {
              const user = usersById.get(event.on_behalf_of_user_id ?? event.actor_id);
              return (
                <li key={event.id} className="flex items-start gap-3 py-3">
                  <div className="mt-0.5 rounded-full bg-surface-muted p-2 text-fg-muted">
                    <History size={13} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-fg">
                        {ACTION_LABELS[event.action_id] ? t(ACTION_LABELS[event.action_id]) : event.action_id}
                      </p>
                      <Badge
                        variant={
                          event.result === 'success' ? 'success' : event.result === 'denied' ? 'warning' : 'destructive'
                        }
                      >
                        {event.result}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-fg-faint">
                      {user?.nickname ?? event.actor_id} · {event.actor_type}
                      {event.client_id ? ` · client ${event.client_id}` : ''}
                    </p>
                  </div>
                  <time className="flex-shrink-0 text-[11px] text-fg-faint" dateTime={event.created_at}>
                    {formatDate(event.created_at)}
                  </time>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </Dialog>
  );
}
