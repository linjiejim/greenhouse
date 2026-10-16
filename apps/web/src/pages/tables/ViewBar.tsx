import { useOverlayDraft } from '../../lib/useOverlayDraft';
/**
 * A table's views (patterns.md, 数据视图: views switch like tabs): shared ones first, then mine,
 * each with its own actions; 「新建视图」 for a type. When the reader changed a view they may not
 * save, it says so and offers to keep the change as a view of their own.
 */

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Copy, Pencil, Plus, Trash2, User } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Field,
  FieldGroup,
  Input,
  Menu,
  Overlay,
  OverlayActions,
  Segmented,
  useContextMenu,
  type MenuEntry,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { TABLE_VIEW_TYPES, type Base, type BaseTable, type View, type ViewConfig } from '@greenhouse/contract';

type ViewType = (typeof TABLE_VIEW_TYPES)[number];
import { useNotify } from '../../app/notify';
import { putView, refreshBase } from '../../data/tables';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { tablesError } from './errors';
import { NameDialog } from './TableTabs';
import { viewIcon } from './TablesDirectory';

/** Names a new view: its type, who sees it, and (for a copy or kept changes) its settings. */
export function NewViewDialog({
  base,
  table,
  type: initialType,
  config,
  name: initialName,
  canBuild,
  onCreated,
  onClose,
}: {
  base: Base;
  table: BaseTable;
  type?: ViewType;
  config?: ViewConfig;
  name?: string;
  canBuild: boolean;
  onCreated?: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [type, setType] = useState<ViewType>(initialType ?? 'grid');
  const [name, setName] = useState(initialName ?? t(`tables.view.${initialType ?? 'grid'}`));
  const [personal, setPersonal] = useState(!canBuild);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dismiss = useOverlayDraft({ type, name, personal }, busy, onClose);
  const create = async () => {
    setBusy(true);
    try {
      const view = await api.tables.tables.createView(table.id, {
        name: name.trim() || t(`tables.view.${type}`),
        type,
        personal,
        ...(config && type === initialType ? { config } : {}),
      });
      putView(base.id, view);
      void refreshBase(base.id);
      onCreated?.();
      dismiss.saved();
      navigate({ page: 'base', id: base.id, table: table.id, view: view.id });
    } catch (failure) {
      setError(tablesError(failure, t));
      setBusy(false);
    }
  };
  return (
    <>
      <Overlay variant="dialog" title={t('tables.addView')} onClose={onClose} beforeClose={dismiss.beforeClose}>
        <form
          {...dismiss.formProps}
          id={formId}
          className="app-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          {!config && (
            <FieldGroup label={t('tables.viewType')}>
              <div className="app-tb-view-types" role="radiogroup" aria-label={t('tables.viewType')}>
                {TABLE_VIEW_TYPES.map((entry) => (
                  <button
                    key={entry}
                    type="button"
                    role="radio"
                    aria-checked={type === entry}
                    className={cx('app-tb-view-type', type === entry && 'is-on')}
                    onClick={() => {
                      if (name === t(`tables.view.${type}`)) setName(t(`tables.view.${entry}`));
                      setType(entry);
                    }}
                  >
                    {viewIcon(entry)}
                    <span>{t(`tables.view.${entry}`)}</span>
                  </button>
                ))}
              </div>
            </FieldGroup>
          )}
          <Field label={t('tables.viewName')} error={error || undefined}>
            <Input data-autofocus value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
          </Field>
          {canBuild && (
            <FieldGroup label={t('tables.viewScope')} description={t('tables.viewScopeHint')}>
              <Segmented
                label={t('tables.viewScope')}
                items={[
                  { value: 'shared', label: t('tables.viewShared') },
                  { value: 'personal', label: t('tables.viewPersonal') },
                ]}
                value={personal ? 'personal' : 'shared'}
                onChange={(next) => setPersonal(next === 'personal')}
              />
            </FieldGroup>
          )}
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form={formId} loading={busy}>
            {t('tables.createView')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}

function ViewTab({
  base,
  table,
  view,
  selected,
  canBuild,
  onRename,
  onDuplicate,
  onDelete,
}: {
  base: Base;
  table: BaseTable;
  view: View;
  selected: boolean;
  canBuild: boolean;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const items: MenuEntry[] = [
    ...(view.editable ? [{ label: t('tables.renameView'), icon: <Pencil size={icon.md} />, onClick: onRename }] : []),
    { label: t('tables.duplicateView'), icon: <Copy size={icon.md} />, onClick: onDuplicate },
    ...(view.editable && (view.personal || canBuild)
      ? [
          '-' as const,
          { label: t('tables.deleteView'), icon: <Trash2 size={icon.md} />, danger: true, onClick: onDelete },
        ]
      : []),
  ];
  const context = useContextMenu(items, view.name);
  return (
    <>
      <button
        type="button"
        role="tab"
        aria-selected={selected}
        tabIndex={selected ? 0 : -1}
        className={cx('app-tb-view-tab', context.open && 'is-menu-open')}
        {...context.handlers}
        onClick={() => navigate({ page: 'base', id: base.id, table: table.id, view: view.id })}
      >
        {viewIcon(view.type, icon.sm)}
        <span>{view.name}</span>
        {view.personal && <User size={icon.sm} strokeWidth={icon.stroke} aria-label={t('tables.personal')} />}
      </button>
      {context.menu}
    </>
  );
}

export function ViewBar({
  base,
  table,
  views,
  current,
  canBuild,
  draft,
  onDraftDone,
  onRename,
}: {
  base: Base;
  table: BaseTable;
  views: View[];
  current: View;
  canBuild: boolean;
  /** The reader's unsaved change to the current view. */
  draft: ViewConfig | null;
  onDraftDone: () => void;
  onRename: (view: View, name: string) => void;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const list = useRef<HTMLDivElement>(null);
  const [creating, setCreating] = useState<{ type?: ViewType; config?: ViewConfig; name?: string } | null>(null);
  const [renaming, setRenaming] = useState<View | null>(null);
  const [deleting, setDeleting] = useState<View | null>(null);
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
  return (
    <div className="app-tb-viewbar">
      <div ref={list} className="app-tb-view-tabs" role="tablist" aria-label={t('tables.views')} onKeyDown={move}>
        {views.map((view) => (
          <ViewTab
            key={view.id}
            base={base}
            table={table}
            view={view}
            selected={view.id === current.id}
            canBuild={canBuild}
            onRename={() => setRenaming(view)}
            onDuplicate={() =>
              setCreating({
                type: view.type as ViewType,
                config: view.config,
                name: t('tables.copyName', { name: view.name }),
              })
            }
            onDelete={() => setDeleting(view)}
          />
        ))}
      </div>
      <Menu
        label={t('tables.addView')}
        trigger={
          <>
            <Plus size={icon.sm} strokeWidth={icon.stroke} />
          </>
        }
        align="start"
        items={TABLE_VIEW_TYPES.map((type) => ({
          label: t(`tables.view.${type}`),
          icon: viewIcon(type),
          onClick: () => setCreating({ type }),
        }))}
      />
      {draft && (
        <span className="app-tb-draft" role="status">
          <span className="app-tb-draft-note">{t('tables.draft')}</span>
          <Button
            size="sm"
            onClick={() => setCreating({ type: current.type as ViewType, config: draft, name: current.name })}
          >
            {t('tables.saveAsView')}
          </Button>
          <Button size="sm" kind="ghost" onClick={onDraftDone}>
            {t('tables.discardDraft')}
          </Button>
        </span>
      )}
      {creating && (
        <NewViewDialog
          base={base}
          table={table}
          type={creating.type}
          config={creating.config}
          name={creating.name}
          canBuild={canBuild}
          onCreated={() => {
            if (draft && creating.config === draft) onDraftDone();
          }}
          onClose={() => setCreating(null)}
        />
      )}
      {renaming && (
        <NameDialog
          title={t('tables.renameView')}
          label={t('tables.viewName')}
          initial={renaming.name}
          submit={t('tables.save')}
          onClose={() => setRenaming(null)}
          onSave={async (name) => onRename(renaming, name)}
        />
      )}
      {deleting && (
        <ConfirmDialog
          danger
          title={t('tables.deleteViewTitle', { name: deleting.name })}
          confirmLabel={t('tables.deleteView')}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            const view = deleting;
            setDeleting(null);
            void api.tables.views
              .remove(view.id)
              .then(async () => {
                await refreshBase(base.id);
                if (view.id === current.id) navigate({ page: 'base', id: base.id, table: table.id }, { replace: true });
              })
              .catch((error: unknown) => notify(tablesError(error, t)));
          }}
        >
          {t('tables.deleteViewBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}
