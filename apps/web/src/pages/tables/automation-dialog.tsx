/**
 * A Base's automations (builders only): the rule list, the rule editor and a
 * rule's run log, one at a time inside a workspace-size dialog. The parts live
 * in ./automations/ (draft model, editor, action forms, run log).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, ConfirmDialog, Dialog, EmptyState, IconButton, Spinner, Tag, Toggle } from '../../components/ui';
import { Edit3, History, Plus, Trash2, Zap } from '../../lib/icons';
import {
  deleteTableAutomation,
  listTableAutomations,
  updateTableAutomation,
  type TableAutomation,
  type TableDefinition,
  type TableUserOption,
} from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { AppReferencesDialog, useAppReferencesGuard } from '../../components/tables/app-references';
import { RuleEditor } from './automations/rule-editor';
import { RunLog } from './automations/run-log';
import { TRIGGER_LABEL_KEYS } from './automations/rule-draft';

type View = { kind: 'list' } | { kind: 'edit'; rule: TableAutomation | null } | { kind: 'runs'; rule: TableAutomation };

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
  users: TableUserOption[];
  onClose: () => void;
}) {
  const t = useT();
  const [automations, setAutomations] = useState<TableAutomation[]>([]);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<TableAutomation | null>(null);
  const [error, setError] = useState('');
  /** Deleting a rule an app's button runs asks again with where (D6). */
  const appReferences = useAppReferencesGuard();
  const usersById = useMemo(() => new Map(users.map((user) => [user.id, user])), [users]);

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
    if (!open) return;
    setView({ kind: 'list' });
    void load();
  }, [load, open]);

  const toggle = async (automation: TableAutomation) => {
    setBusyId(automation.id);
    try {
      await updateTableAutomation(automation.id, {
        revision: automation.revision,
        status: automation.status === 'enabled' ? 'disabled' : 'enabled',
      });
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.automations.updateFailed'));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    const rule = deleting;
    try {
      await appReferences.guard(
        async (confirm) => {
          await (confirm ? deleteTableAutomation(rule.id, { confirm: true }) : deleteTableAutomation(rule.id));
          await load();
        },
        {
          title: t('apps.builder.references.automationTitle', { name: rule.name }),
          confirmLabel: t('apps.builder.references.deleteAnyway'),
        },
      );
      setDeleting(null);
    } catch (deleteError) {
      setDeleting(null);
      setError(deleteError instanceof Error ? deleteError.message : t('tables.automations.deleteFailed'));
    }
  };

  const tableName = (tableId: number) =>
    tables.find((table) => table.id === tableId)?.name ?? t('tables.automations.tableNumber', { id: tableId });

  return (
    <Dialog open={open} onClose={onClose} title={t('tables.automations.title')} size="workspace">
      {view.kind === 'edit' ? (
        <RuleEditor
          baseId={baseId}
          tables={tables}
          users={users}
          rule={view.rule}
          onCancel={() => setView({ kind: 'list' })}
          onSaved={() => {
            setView({ kind: 'list' });
            void load();
          }}
        />
      ) : view.kind === 'runs' ? (
        <RunLog rule={view.rule} onBack={() => setView({ kind: 'list' })} />
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-start gap-3">
            <p className="min-w-0 flex-1 text-xs leading-5 text-fg-muted">{t('tables.automations.description')}</p>
            <Button
              size="sm"
              onClick={() => setView({ kind: 'edit', rule: null })}
              disabled={tables.length === 0}
              data-testid="automation-new"
            >
              <Plus size={13} className="mr-1.5" />
              {t('tables.automations.newAutomation')}
            </Button>
          </div>
          {error && <p className="rounded-md bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
          {loading && automations.length === 0 ? (
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
            <ul className="divide-y divide-edge rounded-lg border border-edge">
              {automations.map((automation) => {
                const executor = usersById.get(automation.execution_user_id);
                return (
                  <li key={automation.id} className="flex flex-wrap items-center gap-3 px-3 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-fg">{automation.name}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-fg-faint">
                        <span>{tableName(automation.table_id)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{t(TRIGGER_LABEL_KEYS[automation.trigger])}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          {t('tables.automations.runsAs', {
                            name: executor?.nickname || executor?.email || automation.execution_user_id,
                          })}
                        </span>
                      </p>
                    </div>
                    <Tag tone={automation.status === 'enabled' ? 'success' : 'neutral'}>
                      {automation.status === 'enabled' ? t('common.enabled') : t('common.disabled')}
                    </Tag>
                    <Toggle
                      size="sm"
                      checked={automation.status === 'enabled'}
                      disabled={busyId === automation.id}
                      label={t('tables.automations.enabled')}
                      onChange={() => void toggle(automation)}
                    />
                    <IconButton
                      label={t('tables.automations.runs')}
                      size="compact"
                      onClick={() => setView({ kind: 'runs', rule: automation })}
                    >
                      <History size={14} />
                    </IconButton>
                    <IconButton
                      label={t('tables.automations.edit')}
                      size="compact"
                      onClick={() => setView({ kind: 'edit', rule: automation })}
                    >
                      <Edit3 size={14} />
                    </IconButton>
                    <IconButton
                      label={t('tables.automations.delete')}
                      size="compact"
                      variant="destructive"
                      onClick={() => setDeleting(automation)}
                    >
                      <Trash2 size={14} />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t('tables.automations.deleteTitle')}
        description={deleting ? t('tables.automations.deleteMessage', { name: deleting.name }) : undefined}
        confirmLabel={t('tables.automations.delete')}
        confirmVariant="destructive"
        onConfirm={() => void remove()}
        onClose={() => setDeleting(null)}
      />
      <AppReferencesDialog request={appReferences.request} onClose={appReferences.close} />
    </Dialog>
  );
}
