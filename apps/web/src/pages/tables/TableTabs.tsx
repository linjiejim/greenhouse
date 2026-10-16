import { useOverlayDraft } from '../../lib/useOverlayDraft';
/**
 * A base's data tables as tabs, then its dashboards, with their actions on right-click (or a long
 * press) and a "+" for builders (a data table or a dashboard). Arrow keys move between tabs;
 * Enter or Space opens one.
 */

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { LayoutDashboard, Pencil, Plus, Table2, Trash2 } from 'lucide-react';
import {
  Button,
  Field,
  Input,
  Menu,
  Overlay,
  OverlayActions,
  useContextMenu,
  type MenuEntry,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { Base, BaseTable } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { refreshBase } from '../../data/tables';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { NewDashboardDialog } from './dashboards/NewDashboardDialog';
import { tablesError } from './errors';

/** Names a new data table, or renames one. */
export function NameDialog({
  title,
  label,
  initial,
  submit,
  onSave,
  onClose,
}: {
  title: string;
  label: string;
  initial: string;
  submit: string;
  onSave: (name: string) => Promise<unknown>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dismiss = useOverlayDraft(name, busy, onClose);
  const save = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave(name.trim());
      onClose();
    } catch (failure) {
      setError(tablesError(failure, t));
      setBusy(false);
    }
  };
  return (
    <>
      <Overlay variant="dialog" title={title} onClose={onClose} beforeClose={dismiss.beforeClose}>
        <form
          {...dismiss.formProps}
          id={formId}
          className="app-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label={label} error={error || undefined}>
            <Input data-autofocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
          </Field>
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form={formId} loading={busy} disabled={!name.trim()}>
            {submit}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}

function Tab({
  base,
  table,
  selected,
  canBuild,
  onRename,
  onDelete,
}: {
  base: Base;
  table: BaseTable;
  selected: boolean;
  canBuild: boolean;
  onRename: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const items: MenuEntry[] = canBuild
    ? [
        { label: t('tables.renameTable'), icon: <Pencil size={icon.md} />, onClick: onRename },
        '-',
        { label: t('tables.deleteTable'), icon: <Trash2 size={icon.md} />, danger: true, onClick: onDelete },
      ]
    : [];
  const context = useContextMenu(items, table.name);
  const handlers = canBuild ? context.handlers : {};
  return (
    <>
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        className={cx(context.open && 'is-menu-open')}
        {...handlers}
        onClick={() => navigate({ page: 'base', id: base.id, table: table.id })}
      >
        {table.name}
      </button>
      {context.menu}
    </>
  );
}

export function TableTabs({
  base,
  current,
  dashboard,
  canBuild,
}: {
  base: Base;
  current?: string;
  /** The dashboard on screen, instead of a table. */
  dashboard?: string;
  canBuild: boolean;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const list = useRef<HTMLDivElement>(null);
  const [naming, setNaming] = useState<BaseTable | 'new' | null>(null);
  const [newDashboard, setNewDashboard] = useState(false);
  const dashboards = base.views.filter((view) => view.type === 'dashboard');
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []);
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (at + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  };
  if (!base.tables.length && !canBuild) return null;
  return (
    <div className="app-tb-tabs-row">
      <div
        ref={list}
        className="gh-tabs app-tb-tabs"
        role="tablist"
        aria-label={t('tables.tablesLabel')}
        onKeyDown={move}
      >
        {base.tables.map((table) => (
          <Tab
            key={table.id}
            base={base}
            table={table}
            selected={table.id === current}
            canBuild={canBuild}
            onRename={() => setNaming(table)}
            onDelete={() =>
              void api.tables.tables
                .archive(table.id)
                .then(async () => {
                  await refreshBase(base.id);
                  if (table.id === current) navigate({ page: 'base', id: base.id }, { replace: true });
                  notify(t('tables.tableDeleted', { name: table.name }), {
                    label: t('tables.undo'),
                    onClick: () => void api.tables.tables.restore(table.id).then(() => refreshBase(base.id)),
                  });
                })
                .catch((error: unknown) => notify(tablesError(error, t)))
            }
          />
        ))}
        {dashboards.map((view) => (
          <button
            key={view.id}
            type="button"
            role="tab"
            aria-selected={view.id === dashboard}
            tabIndex={view.id === dashboard ? 0 : -1}
            className="app-tb-dashboard-tab"
            onClick={() => navigate({ page: 'base', id: base.id, dashboard: view.id })}
          >
            <LayoutDashboard size={icon.sm} strokeWidth={icon.stroke} aria-hidden />
            {view.name}
          </button>
        ))}
      </div>
      {!base.archived_at && (
        <Menu
          label={t('tables.addTableOrDashboard')}
          trigger={<Plus size={icon.md} strokeWidth={icon.stroke} />}
          align="start"
          items={[
            ...(canBuild
              ? [
                  {
                    label: t('tables.addTable'),
                    icon: <Table2 size={icon.md} strokeWidth={icon.stroke} />,
                    onClick: () => setNaming('new'),
                  },
                ]
              : []),
            {
              label: t('tables.addDashboard'),
              icon: <LayoutDashboard size={icon.md} strokeWidth={icon.stroke} />,
              onClick: () => setNewDashboard(true),
            },
          ]}
        />
      )}
      {newDashboard && <NewDashboardDialog base={base} onClose={() => setNewDashboard(false)} />}
      {naming && (
        <NameDialog
          title={naming === 'new' ? t('tables.addTable') : t('tables.renameTable')}
          label={t('tables.tableName')}
          initial={naming === 'new' ? t('tables.tableDefault', { n: base.tables.length + 1 }) : naming.name}
          submit={naming === 'new' ? t('tables.addTable') : t('tables.save')}
          onClose={() => setNaming(null)}
          onSave={async (name) => {
            if (naming === 'new') {
              const made = await api.tables.bases.createTable(base.id, name);
              await refreshBase(base.id);
              navigate({ page: 'base', id: base.id, table: made.id });
            } else {
              await api.tables.tables.update(naming.id, { name });
              await refreshBase(base.id);
            }
          }}
        />
      )}
    </div>
  );
}
