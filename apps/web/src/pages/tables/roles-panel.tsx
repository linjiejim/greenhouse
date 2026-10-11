/**
 * The Roles tab of the share dialog: the Base's custom roles with how many
 * grants use each, and the rule editor for the selected one. Deleting a role
 * that people, groups or the team default still use is refused by the server
 * (409 `role_in_use`); the counts it returns say what to reassign first.
 */

import { useEffect, useState } from 'react';
import {
  EMPTY_TABLE_ACCESS_RULES,
  normalizeAccessRules,
  roleInUse,
  type TableAccessRules,
  type TableRoleReferences,
} from '@greenhouse/types/table-access';
import {
  createTableBaseRole,
  deleteTableBaseRole,
  TablesRequestError,
  updateTableBaseRole,
  type TableBaseRoleList,
  type TableField,
  type TableUserOption,
} from '../../lib/api/tables';
import { Badge, Button, ConfirmDialog, EmptyState, Input, Textarea } from '../../components/ui';
import { FormField } from '../../components/form';
import { Plus, Shield } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { incompleteRowScope, RoleEditor, useIncompleteScopeMessage } from './role-editor';

interface RoleDraft {
  id?: number;
  revision?: number;
  name: string;
  description: string;
  rules: TableAccessRules;
}

export function RolesPanel({
  baseId,
  list,
  fieldsByTable,
  users,
  saving,
  run,
}: {
  baseId: number;
  list: TableBaseRoleList;
  fieldsByTable: ReadonlyMap<number, TableField[]>;
  users: TableUserOption[];
  saving: boolean;
  run: (action: () => Promise<unknown>) => Promise<void>;
}) {
  const t = useT();
  const incompleteMessage = useIncompleteScopeMessage();
  const [selected, setSelected] = useState<number | 'new' | null>(list.roles[0]?.id ?? null);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [problem, setProblem] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setProblem('');
    if (selected === 'new') {
      setDraft({
        name: t('tables.access.newRoleName'),
        description: '',
        rules: { ...EMPTY_TABLE_ACCESS_RULES, tables: [] },
      });
      return;
    }
    const role = list.roles.find((entry) => entry.id === selected);
    setDraft(
      role
        ? {
            id: role.id,
            revision: role.revision,
            name: role.name,
            description: role.description ?? '',
            rules: role.rules,
          }
        : null,
    );
  }, [list.roles, selected, t]);

  const usage = (references: TableRoleReferences | undefined) =>
    references
      ? [
          t('tables.access.usedBy', { users: references.users, groups: references.groups }),
          ...(references.team ? [t('tables.access.usedByTeam')] : []),
        ].join(' · ')
      : '';

  const save = () => {
    if (!draft) return;
    const incomplete = incompleteRowScope(draft.rules, fieldsByTable);
    if (incomplete) return setProblem(incompleteMessage(incomplete, list.facts));
    const normalized = normalizeAccessRules(draft.rules, list.facts);
    if (!normalized.ok) return setProblem(normalized.error);
    setProblem('');
    void run(async () => {
      const input = { name: draft.name, description: draft.description || null, rules: normalized.rules };
      if (draft.id && draft.revision) await updateTableBaseRole(draft.id, { revision: draft.revision, ...input });
      else setSelected((await createTableBaseRole(baseId, input)).id);
    });
  };

  const inUseMessage = (counts: TableRoleReferences) =>
    t('tables.access.roleInUse', {
      users: counts.users,
      groups: counts.groups,
      team: counts.team ? t('tables.access.roleInUseTeam') : '',
    });

  /** Say up front when the role is still used; the server re-checks (409) either way. */
  const askDelete = () => {
    const references = list.references.find((entry) => entry.roleId === draft?.id);
    if (references && roleInUse(references)) return setProblem(inUseMessage(references));
    setProblem('');
    setConfirmDelete(true);
  };

  const remove = () => {
    if (!draft?.id) return;
    const roleId = draft.id;
    setConfirmDelete(false);
    void run(async () => {
      try {
        await deleteTableBaseRole(roleId);
        setSelected(null);
      } catch (error) {
        const references = error instanceof TablesRequestError ? error.details?.references : undefined;
        if (!references || typeof references !== 'object') throw error;
        throw new Error(inUseMessage(references as TableRoleReferences));
      }
    });
  };

  return (
    <div className="grid gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="space-y-2">
        <Button size="sm" variant="outline" className="w-full" disabled={saving} onClick={() => setSelected('new')}>
          <Plus size={13} className="mr-1.5" />
          {t('tables.access.newRole')}
        </Button>
        {list.roles.length === 0 && (
          <EmptyState icon={Shield} title={t('tables.access.noRoles')} description={t('tables.access.noRolesHint')} />
        )}
        <ul className="space-y-1" aria-label={t('tables.access.tabs.roles')}>
          {list.roles.map((role) => {
            const references = list.references.find((entry) => entry.roleId === role.id);
            return (
              <li key={role.id}>
                <button
                  type="button"
                  aria-pressed={selected === role.id}
                  onClick={() => setSelected(role.id)}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                    selected === role.id
                      ? 'border-primary-edge bg-primary-subtle text-primary-fg-strong'
                      : 'border-edge text-fg hover:bg-surface-muted'
                  }`}
                >
                  <span className="block truncate text-sm font-medium">{role.name}</span>
                  <span className="block truncate text-[11px] text-fg-faint">{usage(references)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <section className="min-w-0 space-y-4">
        {!draft ? (
          <p className="text-sm text-fg-muted">{t('tables.access.chooseRole')}</p>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
              <FormField label={t('tables.access.roleName')} required>
                <Input
                  value={draft.name}
                  maxLength={60}
                  disabled={saving}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              </FormField>
              <FormField label={t('tables.access.roleDescription')}>
                <Textarea
                  rows={1}
                  value={draft.description}
                  maxLength={500}
                  disabled={saving}
                  onChange={(event) => setDraft({ ...draft, description: event.target.value })}
                />
              </FormField>
            </div>
            <RoleEditor
              rules={draft.rules}
              onChange={(rules) => setDraft({ ...draft, rules })}
              facts={list.facts}
              fieldsByTable={fieldsByTable}
              users={users}
              disabled={saving}
            />
            {problem && <p className="text-xs text-danger">{problem}</p>}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-edge pt-3">
              {draft.id ? (
                <Button variant="ghost" size="sm" disabled={saving} onClick={askDelete}>
                  {t('tables.access.deleteRole')}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                {draft.id && (
                  <Badge variant="secondary">{usage(list.references.find((entry) => entry.roleId === draft.id))}</Badge>
                )}
                <Button size="sm" disabled={saving || !draft.name.trim()} onClick={save}>
                  {t('tables.access.saveRole')}
                </Button>
              </div>
            </div>
          </>
        )}
      </section>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={remove}
        title={t('tables.access.deleteRoleTitle', { name: draft?.name ?? '' })}
        description={t('tables.access.deleteRoleDescription')}
        confirmLabel={t('common.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}
