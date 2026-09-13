import React, { useCallback, useEffect, useState } from 'react';
import type { TableAutomationTrigger } from '@greenhouse/types/tables';
import { Button, Checkbox, Dialog, EmptyState, Input, Select, Spinner, Textarea } from '../../components/ui';
import { History, Plus, Zap } from '../../lib/icons';
import {
  createTableAutomation,
  listTableAutomationRuns,
  listTableAutomations,
  updateTableAutomation,
  type TableAutomation,
  type TableAutomationRun,
  type TableDefinition,
} from '../../lib/api/tables';
import { formatDate } from '../../lib/utils';
import { useT } from '../../lib/i18n';

type UserOption = { id: string; nickname: string; email: string };

export function TablesAutomationDialog({
  open,
  baseId,
  tables,
  users,
  onClose,
}: {
  open: boolean;
  baseId: number;
  tables: TableDefinition[];
  users: UserOption[];
  onClose: () => void;
}) {
  const t = useT();
  const [automations, setAutomations] = useState<TableAutomation[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [tableId, setTableId] = useState<number | ''>('');
  const [trigger, setTrigger] = useState<TableAutomationTrigger>('record_created');
  const [enabled, setEnabled] = useState(false);
  const [recipientIds, setRecipientIds] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [runs, setRuns] = useState<{ ruleId: number; rows: TableAutomationRun[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setAutomations(await listTableAutomations(baseId));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.automations.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [baseId, t]);

  useEffect(() => {
    if (open) void load();
  }, [load, open]);

  const startCreate = () => {
    setCreating(true);
    setName('');
    setTableId(tables[0]?.id ?? '');
    setTrigger('record_created');
    setEnabled(false);
    setRecipientIds([]);
    setTitle('');
    setMessage('');
  };

  const create = async () => {
    if (!name.trim() || tableId === '' || recipientIds.length === 0 || !title.trim() || !message.trim()) return;
    setSaving(true);
    setError('');
    try {
      await createTableAutomation(baseId, {
        tableId,
        name: name.trim(),
        status: enabled ? 'enabled' : 'disabled',
        trigger,
        config: {
          version: 1,
          actions: [{ type: 'notify', userIds: recipientIds, title: title.trim(), message: message.trim() }],
        },
      });
      setCreating(false);
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.automations.createFailed'));
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (automation: TableAutomation) => {
    setSaving(true);
    try {
      await updateTableAutomation(automation.id, {
        revision: automation.revision,
        status: automation.status === 'enabled' ? 'disabled' : 'enabled',
      });
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.automations.updateFailed'));
    } finally {
      setSaving(false);
    }
  };

  const loadRuns = async (automationId: number) => {
    setRuns({ ruleId: automationId, rows: [] });
    try {
      setRuns({ ruleId: automationId, rows: await listTableAutomationRuns(automationId, 20) });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.automations.loadRunsFailed'));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.automations.title')} size="xl">
      <div className="space-y-4">
        <p className="text-xs leading-5 text-fg-muted">{t('tables.automations.description')}</p>
        {error && <p className="rounded-md bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
        {creating ? (
          <div className="grid grid-cols-1 gap-4 rounded-lg border border-edge bg-surface-sunken p-4 md:grid-cols-2">
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.automations.ruleName')}</label>
              <Input
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={t('tables.automations.ruleNamePlaceholder')}
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.automations.table')}</label>
              <Select value={tableId} onChange={(event) => setTableId(Number(event.target.value))}>
                {tables.map((table) => (
                  <option key={table.id} value={table.id}>
                    {table.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.automations.trigger')}</label>
              <Select value={trigger} onChange={(event) => setTrigger(event.target.value as TableAutomationTrigger)}>
                <option value="record_created">{t('tables.automations.recordCreated')}</option>
                <option value="record_updated">{t('tables.automations.recordUpdated')}</option>
              </Select>
            </div>
            <div className="flex items-end pb-2">
              <Checkbox
                label={t('tables.automations.enableImmediately')}
                checked={enabled}
                onChange={(event) => setEnabled(event.target.checked)}
              />
            </div>
            <div className="md:col-span-2">
              <p className="mb-2 text-xs font-medium text-fg-muted">{t('tables.automations.notifyTeammates')}</p>
              <div className="grid max-h-36 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-edge bg-surface-raised p-3 sm:grid-cols-2">
                {users.map((user) => (
                  <Checkbox
                    key={user.id}
                    label={`${user.nickname} · ${user.email}`}
                    checked={recipientIds.includes(user.id)}
                    onChange={(event) =>
                      setRecipientIds((current) =>
                        event.target.checked ? [...current, user.id] : current.filter((id) => id !== user.id),
                      )
                    }
                  />
                ))}
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">
                {t('tables.automations.notificationTitle')}
              </label>
              <Input value={title} onChange={(event) => setTitle(event.target.value)} />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-fg-muted">{t('tables.automations.message')}</label>
              <Textarea rows={3} value={message} onChange={(event) => setMessage(event.target.value)} />
            </div>
            <div className="flex justify-end gap-2 border-t border-edge pt-3 md:col-span-2">
              <Button variant="ghost" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                disabled={
                  saving ||
                  !name.trim() ||
                  tableId === '' ||
                  recipientIds.length === 0 ||
                  !title.trim() ||
                  !message.trim()
                }
                onClick={() => void create()}
              >
                {t('tables.automations.createRule')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex justify-end">
            <Button size="sm" onClick={startCreate} disabled={tables.length === 0}>
              <Plus size={13} className="mr-1.5" />
              {t('tables.automations.newAutomation')}
            </Button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : automations.length === 0 ? (
          <EmptyState
            icon={Zap}
            variant="compact"
            tone="neutral"
            title={t('tables.automations.emptyTitle')}
            description={t('tables.automations.emptyDescription')}
          />
        ) : (
          <div className="divide-y divide-edge rounded-lg border border-edge">
            {automations.map((automation) => (
              <div key={automation.id} className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-fg">{automation.name}</p>
                    <p className="mt-0.5 text-[11px] text-fg-faint">
                      {tables.find((table) => table.id === automation.table_id)?.name ??
                        t('tables.automations.tableNumber', { id: automation.table_id })}{' '}
                      ·{' '}
                      {automation.trigger === 'record_created'
                        ? t('tables.automations.recordCreated')
                        : t('tables.automations.recordUpdated')}{' '}
                      · {t('tables.automations.revision', { revision: automation.revision })}
                    </p>
                  </div>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase ${automation.status === 'enabled' ? 'bg-success-subtle text-success' : 'bg-surface-muted text-fg-faint'}`}
                  >
                    {automation.status === 'enabled' ? t('common.enabled') : t('common.disabled')}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => void loadRuns(automation.id)}>
                    <History size={13} className="mr-1.5" />
                    {t('tables.automations.runs')}
                  </Button>
                  <Button variant="outline" size="sm" disabled={saving} onClick={() => void toggle(automation)}>
                    {automation.status === 'enabled' ? t('common.disable') : t('common.enable')}
                  </Button>
                </div>
                {runs?.ruleId === automation.id && (
                  <div className="mt-3 rounded-md bg-surface-sunken p-3">
                    {runs.rows.length === 0 ? (
                      <p className="text-xs text-fg-faint">{t('tables.automations.noRuns')}</p>
                    ) : (
                      runs.rows.map((run) => (
                        <div
                          key={run.id}
                          className="flex items-center justify-between gap-3 border-b border-edge py-1.5 text-xs last:border-b-0"
                        >
                          <span className="text-fg-secondary">
                            {t('tables.automations.runSummary', {
                              id: run.id,
                              status: run.status,
                              count: run.actions_completed,
                            })}
                          </span>
                          <span className="text-fg-faint">{formatDate(run.started_at)}</span>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}
