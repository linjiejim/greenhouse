/**
 * The app's roles (spec §2 / D3 / D4): a role is which pages someone sees,
 * whether they may comment, and — table by table — what they read and change,
 * in the same rule shape and through the same rule editor as a Base's custom
 * roles (`RoleEditor` from Phase 0, without its dashboards switch). Who gets
 * which role is decided under Sharing.
 *
 * Deleting a role removes it from every button, form and create list that
 * named it — a list left empty means nobody, never everyone.
 */

import { useEffect, useState } from 'react';
import { APP_LIMITS, type AppRole, type AppSpec, type AppSpecError } from '@greenhouse/types/apps';
import type { TableAccessRules } from '@greenhouse/types/table-access';
import { Button, Checkbox, ConfirmDialog, EmptyState, FilterPills, Toggle } from '../../../components/ui';
import type { TableField, TableUserOption } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { Info, Plus, Shield, Trash2 } from '../../../lib/icons';
import { incompleteRowScope, RoleEditor, useIncompleteScopeMessage } from '../../tables/role-editor';
import { PanelSection, SpecErrorList, TextSetting } from './properties/common';
import { roleErrors } from './spec-errors';
import { addRole, deleteRole, roleListMentions, updateRole, type BuilderSchema } from './spec-model';
import type { BuilderBase } from './use-builder-schema';

function rulesOf(role: AppRole): TableAccessRules {
  return { version: 1, tables: role.tables, dashboards: 'none' };
}

export function RolesTab({
  spec,
  base,
  errors,
  edit,
  initialRole,
}: {
  spec: AppSpec;
  base: BuilderBase;
  errors: readonly AppSpecError[];
  edit: (change: (spec: AppSpec) => AppSpec) => void;
  /** Open on this role (from the problems list). */
  initialRole?: string;
}) {
  const t = useT();
  const incompleteMessage = useIncompleteScopeMessage();
  const [selected, setSelected] = useState(initialRole ?? spec.roles[0]?.key ?? '');
  const [deleting, setDeleting] = useState(false);
  const role = spec.roles.find((entry) => entry.key === selected) ?? spec.roles[0];
  useEffect(() => {
    if (!spec.roles.some((entry) => entry.key === selected) && spec.roles[0]) setSelected(spec.roles[0].key);
  }, [selected, spec.roles]);

  const schema: BuilderSchema = base.schema;
  const fieldsByTable = schema.fieldsByTable as ReadonlyMap<number, TableField[]>;
  const users: TableUserOption[] = base.users;

  const add = () => {
    let created = '';
    edit((current) => {
      const result = addRole(current, t('apps.builder.roles.newName'));
      created = result.roleKey;
      return result.spec;
    });
    if (created) setSelected(created);
  };

  if (!role) {
    return <EmptyState icon={Shield} title={t('apps.builder.roles.none')} />;
  }
  const incomplete = incompleteRowScope(rulesOf(role), fieldsByTable);
  const mentions = roleListMentions(spec, role.key);
  const setRole = (change: (role: AppRole) => AppRole) => edit((current) => updateRole(current, role.key, change));

  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_minmax(0,1fr)]" data-testid="app-roles-tab">
      <aside className="space-y-2">
        <p className="text-xs leading-4 text-fg-muted">{t('apps.builder.roles.intro')}</p>
        <ul
          className="flex gap-1 overflow-x-auto scrollbar-hide lg:block lg:space-y-1"
          aria-label={t('apps.builder.roles.listLabel')}
        >
          {spec.roles.map((entry) => {
            const problems = roleErrors(errors, entry.key).length;
            return (
              <li key={entry.key} className="flex-shrink-0">
                <button
                  type="button"
                  aria-pressed={entry.key === role.key}
                  onClick={() => setSelected(entry.key)}
                  data-testid={`app-role-${entry.key}`}
                  className={`flex min-h-11 w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors md:min-h-9 ${
                    entry.key === role.key
                      ? 'border-primary-edge bg-primary-subtle text-primary-fg-strong'
                      : 'border-edge text-fg hover:bg-surface-muted'
                  }`}
                >
                  <span className="min-w-0 flex-1 truncate" title={entry.name}>
                    {entry.name}
                  </span>
                  {problems > 0 && <span className="text-[11px] text-danger">{problems}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {spec.roles.length < APP_LIMITS.roles && (
          <Button variant="outline" size="sm" className="w-full" onClick={add} data-testid="app-add-role">
            <Plus size={13} className="mr-1.5" />
            {t('apps.builder.roles.add')}
          </Button>
        )}
      </aside>

      <section className="min-w-0 space-y-4" key={role.key}>
        <SpecErrorList errors={roleErrors(errors, role.key)} />
        <PanelSection title={t('apps.builder.roles.identity')}>
          <TextSetting
            required
            label={t('apps.builder.roles.name')}
            value={role.name}
            maxLength={APP_LIMITS.nameLength}
            testId="app-role-name"
            onChange={(name) => name && setRole((entry) => ({ ...entry, name }))}
          />
          <p className="text-[11px] text-fg-faint">{t('apps.builder.roles.key', { key: role.key })}</p>
        </PanelSection>

        <PanelSection title={t('apps.builder.roles.pages')} hint={t('apps.builder.roles.pagesHint')}>
          <FilterPills
            variant="segment"
            items={[
              { key: 'all', label: t('apps.builder.roles.allPages') },
              { key: 'some', label: t('apps.builder.roles.somePages') },
            ]}
            activeKey={role.pages === 'all' ? 'all' : 'some'}
            onChange={(next) => {
              if (next === 'all') setRole((entry) => ({ ...entry, pages: 'all' }));
              if (next === 'some' && role.pages === 'all') {
                setRole((entry) => ({ ...entry, pages: spec.pages.map((page) => page.id) }));
              }
            }}
          />
          {role.pages !== 'all' && (
            <div className="space-y-1 rounded-md border border-edge px-3 py-2" data-testid="app-role-pages">
              {spec.pages.map((page) => {
                const pages = role.pages as string[];
                const checked = pages.includes(page.id);
                return (
                  <Checkbox
                    key={page.id}
                    label={page.title}
                    checked={checked}
                    // A role sees at least one page (the server refuses an empty list).
                    disabled={checked && pages.length === 1}
                    onChange={(event) =>
                      setRole((entry) => ({
                        ...entry,
                        pages: event.target.checked
                          ? spec.pages.map((p) => p.id).filter((id) => id === page.id || pages.includes(id))
                          : pages.filter((id) => id !== page.id),
                      }))
                    }
                  />
                );
              })}
            </div>
          )}
        </PanelSection>

        <PanelSection title={t('apps.builder.roles.comments')}>
          <div className="flex items-start justify-between gap-3">
            <p className="min-w-0 text-[11px] leading-4 text-fg-faint">{t('apps.builder.roles.commentsHint')}</p>
            <Toggle
              size="sm"
              checked={role.canComment === true}
              label={t('apps.builder.roles.comments')}
              onChange={(on) =>
                setRole((entry) => {
                  const next = { ...entry };
                  if (on) next.canComment = true;
                  else delete next.canComment;
                  return next;
                })
              }
            />
          </div>
        </PanelSection>

        <PanelSection title={t('apps.builder.roles.tables')} hint={t('apps.builder.roles.tablesHint')}>
          {!base.exactFacts && (
            <p className="flex items-start gap-1.5 rounded-md border border-edge bg-surface-sunken px-3 py-2 text-[11px] leading-4 text-fg-muted">
              <Info size={12} className="mt-0.5 flex-shrink-0" />
              {t('apps.builder.roles.inexactFacts')}
            </p>
          )}
          <RoleEditor
            rules={rulesOf(role)}
            onChange={(rules) => setRole((entry) => ({ ...entry, tables: rules.tables }))}
            facts={base.facts}
            fieldsByTable={fieldsByTable}
            users={users}
            showDashboards={false}
          />
          {incomplete && <p className="text-xs text-warning">{incompleteMessage(incomplete, base.facts)}</p>}
        </PanelSection>

        <div className="flex justify-end border-t border-edge pt-3">
          <Button
            variant="ghost"
            size="sm"
            disabled={spec.roles.length <= 1}
            title={spec.roles.length <= 1 ? t('apps.builder.roles.deleteLast') : undefined}
            onClick={() => setDeleting(true)}
          >
            <Trash2 size={13} className="mr-1.5" />
            {t('apps.builder.roles.delete')}
          </Button>
        </div>
      </section>

      <ConfirmDialog
        open={deleting}
        onClose={() => setDeleting(false)}
        onConfirm={() => {
          setDeleting(false);
          edit((current) => deleteRole(current, role.key));
        }}
        title={t('apps.builder.roles.deleteTitle', { name: role.name })}
        description={
          mentions > 0
            ? `${t('apps.builder.roles.deleteDescription')} ${t('apps.builder.roles.deleteMentions', { count: mentions })}`
            : t('apps.builder.roles.deleteDescription')
        }
        confirmLabel={t('apps.builder.roles.delete')}
        confirmVariant="destructive"
      />
    </div>
  );
}
