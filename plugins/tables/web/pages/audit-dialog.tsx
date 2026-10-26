import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Dialog, EmptyState, Spinner } from '@greenhouse/web/extension-kit';
import { History } from '@greenhouse/web/extension-kit';
import { listTableBaseAudit, type TableAuditEvent } from '../api';
import { formatDate } from '@greenhouse/web/extension-kit';
import { useT, type AnyTranslationKey as TranslationKey } from '@greenhouse/web/extension-kit';

interface TablesAuditDialogProps {
  open: boolean;
  baseId: string;
  users: Array<{ id: string; nickname: string; email: string }>;
  onClose: () => void;
}

const ACTION_LABELS: Record<string, TranslationKey> = {
  createBase: 'ext.tables.tables.audit.createBase',
  updateBase: 'ext.tables.tables.audit.updateBase',
  archiveBase: 'ext.tables.tables.audit.archiveBase',
  manageMembers: 'ext.tables.tables.audit.manageMembers',
  createTable: 'ext.tables.tables.audit.createTable',
  updateTable: 'ext.tables.tables.audit.updateTable',
  createField: 'ext.tables.tables.audit.createField',
  updateField: 'ext.tables.tables.audit.updateField',
  archiveField: 'ext.tables.tables.audit.archiveField',
  createView: 'ext.tables.tables.audit.createView',
  updateView: 'ext.tables.tables.audit.updateView',
  createRecord: 'ext.tables.tables.audit.createRecord',
  updateRecord: 'ext.tables.tables.audit.updateRecord',
  batchUpsertRecords: 'ext.tables.tables.audit.batchUpsertRecords',
  deleteRecord: 'ext.tables.tables.audit.deleteRecord',
  listBaseAudit: 'ext.tables.tables.audit.listBaseAudit',
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
      .catch((loadError) =>
        setError(loadError instanceof Error ? loadError.message : t('ext.tables.tables.audit.loadFailed')),
      )
      .finally(() => setLoading(false));
  }, [baseId, open, t]);

  return (
    <Dialog open={open} onClose={onClose} title={t('ext.tables.tables.audit.title')} size="lg">
      <div className="max-h-[65vh] overflow-y-auto">
        {loading && events.length === 0 ? (
          <div className="flex justify-center py-16">
            <Spinner className="h-6 w-6 text-fg-faint" />
          </div>
        ) : error ? (
          <p className="rounded-sm border border-danger bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>
        ) : events.length === 0 ? (
          <EmptyState
            icon={History}
            variant="compact"
            tone="neutral"
            title={t('ext.tables.tables.audit.empty')}
            description={t('ext.tables.tables.audit.emptyHint')}
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
                  <time className="flex-shrink-0 text-caption text-fg-faint" dateTime={event.created_at}>
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
