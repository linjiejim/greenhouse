/** Owners manage custom roles in one drawer; table rules reuse the existing filter editor. */
import { useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  FieldGroup,
  Input,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
  TextArea,
} from '@greenhouse/ui/kit';
import {
  MAX_ROLES,
  ROLE_TABLE_ACCESS,
  type Base,
  type BaseCustomRole,
  type RoleRules,
  type RoleTableRules,
} from '@greenhouse/contract';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { queryClient } from '../../data/query';
import { refreshBase, tablesKeys } from '../../data/tables';
import { CardFilter } from './dashboards/CardFilter';
import { tablesError } from './errors';
import { useDraftNavigation } from '../../lib/useDraftNavigation';

export function RolesDrawer({ base, onClose }: { base: Base; onClose: () => void }) {
  const { t } = useI18n();
  const formId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const roles = useQuery({ queryKey: tablesKeys.roles(base.id), queryFn: () => api.tables.bases.roles(base.id) });
  const [editing, setEditing] = useState<BaseCustomRole | 'new' | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [rules, setRules] = useState<RoleRules>({ tables: {} });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<BaseCustomRole | null>(null);
  const [leaving, setLeaving] = useState(false);
  const dirty =
    !!editing &&
    (name !== (editing === 'new' ? '' : editing.name) ||
      description !== (editing === 'new' ? '' : editing.description) ||
      JSON.stringify(rules) !== JSON.stringify(editing === 'new' ? { tables: {} } : editing.rules));
  const navigation = useDraftNavigation(dirty, busy, (navigating) => {
    setEditing(null);
    if (leaving || navigating) onClose();
  });
  const start = (role: BaseCustomRole | 'new') => {
    setEditing(role);
    setName(role === 'new' ? '' : role.name);
    setDescription(role === 'new' ? '' : role.description);
    setRules(role === 'new' ? { tables: {} } : role.rules);
    setError('');
  };
  const update = (tableId: string, change: Partial<RoleTableRules>) =>
    setRules((current) => ({
      tables: { ...current.tables, [tableId]: { ...(current.tables[tableId] ?? { access: 'none' }), ...change } },
    }));
  const refresh = async () => {
    await roles.refetch();
    await refreshBase(base.id);
    await queryClient.invalidateQueries({ queryKey: tablesKeys.shares(base.id) });
  };
  const save = async () => {
    if (busy) return;
    if (!name.trim()) {
      setError(t('tables.roles.nameRequired'));
      nameInput.current?.focus();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const input = { name: name.trim(), description, rules };
      if (editing === 'new') await api.tables.bases.createRole(base.id, input);
      else if (editing) await api.tables.roles.update(editing.id, { ...input, revision: editing.revision });
      await refresh();
      setEditing(null);
    } catch (failure) {
      setError(tablesError(failure, t));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Overlay
      title={t('tables.roles.title')}
      onClose={onClose}
      beforeClose={() => {
        if (busy) return false;
        if (!dirty) return true;
        setLeaving(true);
        navigation.ask();
        return false;
      }}
    >
      {editing ? (
        <form
          id={formId}
          className="app-form"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <Field label={t('tables.roles.name')} required error={error || undefined}>
            <Input
              autoFocus
              ref={nameInput}
              value={name}
              maxLength={60}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          <Field label={t('tables.roles.description')}>
            <TextArea
              value={description}
              maxLength={500}
              rows={2}
              onChange={(event) => setDescription(event.target.value)}
            />
          </Field>
          {base.tables.map((table) => {
            const rule = rules.tables[table.id] ?? { access: 'none' };
            return (
              <section key={table.id} className="app-tb-role-table" aria-label={table.name}>
                <h3 className="app-section-title">{table.name}</h3>
                <FieldGroup label={t('tables.roles.access')}>
                  <Select
                    label={t('tables.roles.access')}
                    value={rule.access}
                    options={ROLE_TABLE_ACCESS.map((value) => ({ value, label: t(`tables.roles.access.${value}`) }))}
                    onChange={(access) => update(table.id, { access: access as RoleTableRules['access'] })}
                  />
                </FieldGroup>
                {rule.access !== 'none' && (
                  <>
                    <FieldGroup label={t('tables.roles.rows')} description={t('tables.roles.rowsHint')}>
                      <CardFilter
                        fields={table.fields}
                        filter={rule.rows ?? undefined}
                        immediate
                        onChange={(rows) => update(table.id, { rows: rows ?? null })}
                      />
                    </FieldGroup>
                    <FieldGroup label={t('tables.roles.columns')} description={t('tables.roles.columnsHint')}>
                      <div className="app-tb-role-columns">
                        {table.fields
                          .filter((field) => !field.is_primary)
                          .map((field) => (
                            <Checkbox
                              key={field.id}
                              label={field.name}
                              checked={!rule.hidden_fields?.includes(field.id)}
                              onChange={(visible) =>
                                update(table.id, {
                                  hidden_fields: visible
                                    ? (rule.hidden_fields ?? []).filter((id) => id !== field.id)
                                    : [...(rule.hidden_fields ?? []), field.id],
                                })
                              }
                            />
                          ))}
                      </div>
                    </FieldGroup>
                  </>
                )}
              </section>
            );
          })}
        </form>
      ) : roles.isPending ? (
        <Skeleton lines={5} />
      ) : roles.isError ? (
        <ErrorBox onRetry={() => void roles.refetch()}>{tablesError(roles.error, t)}</ErrorBox>
      ) : (
        <>
          {error && (
            <p className="app-form-error" role="alert">
              {error}
            </p>
          )}
          {!roles.data.items.length ? (
            <Empty title={t('tables.roles.empty')} />
          ) : (
            <ul className="app-list">
              {roles.data.items.map((role) => (
                <li key={role.id} className="app-list-row">
                  <span className="app-list-main">
                    <span className="app-list-title">{role.name}</span>
                    {role.description && <span className="app-list-meta">{role.description}</span>}
                  </span>
                  <Button size="sm" onClick={() => start(role)}>
                    {t('tables.roles.edit')}
                  </Button>
                  <Button size="sm" kind="danger" onClick={() => setDeleting(role)}>
                    {t('tables.roles.delete')}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <OverlayActions>
        {editing ? (
          <>
            <Button
              disabled={busy}
              onClick={() => {
                if (dirty) {
                  setLeaving(false);
                  navigation.ask();
                } else setEditing(null);
              }}
            >
              {t('common.cancel')}
            </Button>
            <Button key="save" kind="primary" loading={busy} type="submit" form={formId}>
              {t('tables.roles.save')}
            </Button>
          </>
        ) : (
          <Button
            key="create"
            kind="primary"
            disabled={roles.isPending || roles.isError || (roles.data?.items.length ?? 0) >= MAX_ROLES}
            disabledReason={(roles.data?.items.length ?? 0) >= MAX_ROLES ? t('tables.error.too_many_roles') : undefined}
            onClick={() => start('new')}
          >
            {t('tables.roles.create')}
          </Button>
        )}
      </OverlayActions>
      {deleting && (
        <ConfirmDialog
          danger
          title={t('tables.roles.deleteTitle', { name: deleting.name })}
          confirmLabel={t('tables.roles.delete')}
          onCancel={() => setDeleting(null)}
          onConfirm={async () => {
            setBusy(true);
            try {
              await api.tables.roles.remove(deleting.id);
              setDeleting(null);
              await refresh();
            } catch (failure) {
              setDeleting(null);
              setError(tablesError(failure, t));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('tables.roles.deleteBody')}
        </ConfirmDialog>
      )}
      {navigation.asking && (
        <ConfirmDialog
          danger
          title={t('tables.record.discardTitle')}
          confirmLabel={t('tables.record.discard')}
          onCancel={navigation.cancel}
          onConfirm={navigation.discard}
        >
          {t('tables.record.discardBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
