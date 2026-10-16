import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, Field, FieldGroup, Input, MultiSelect, Select } from '@greenhouse/ui/kit';
import type { AppAudience, AppSpec, Base } from '@greenhouse/contract';
import { usePeople } from '../../data/people';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { CardFilter } from '../tables/dashboards/CardFilter';
import { localId } from './model';
export function RolesEditor({
  base,
  roles,
  onChange,
}: {
  base: Base;
  roles: AppSpec['roles'];
  onChange: (roles: AppSpec['roles']) => void;
}) {
  const t = useT();
  const [active, setActive] = useState(roles[0]?.id ?? '');
  const role = roles.find((r) => r.id === active);
  const change = (value: typeof role) => onChange(roles.map((r) => (r.id === value?.id ? value : r)));
  return (
    <div className="app-form">
      <p className="app-muted">{t('apps.baseRights')}</p>
      <FieldGroup label={t('apps.roles')}>
        <Select
          label={t('apps.roles')}
          value={active}
          options={roles.map((r) => ({ value: r.id, label: r.name }))}
          onChange={setActive}
        />
      </FieldGroup>
      <Button
        onClick={() => {
          const id = localId();
          onChange([...roles, { id, name: t('apps.roleName'), rules: { tables: {} } }]);
          setActive(id);
        }}
      >
        {t('apps.addRole')}
      </Button>
      {role && (
        <>
          <Field label={t('apps.roleName')}>
            <Input value={role.name} onChange={(e) => change({ ...role, name: e.target.value })} />
          </Field>
          {base.tables.map((table) => {
            const rules = role.rules.tables[table.id] ?? { access: 'none' as const };
            const set = (patch: Partial<typeof rules>) =>
              change({ ...role, rules: { tables: { ...role.rules.tables, [table.id]: { ...rules, ...patch } } } });
            return (
              <section className="app-ap-action-edit" key={table.id}>
                <h3>{table.name}</h3>
                <FieldGroup label={t('apps.access')}>
                  <Select
                    label={`${table.name} · ${t('apps.access')}`}
                    value={rules.access}
                    options={(['none', 'read', 'edit'] as const).map((value) => ({
                      value,
                      label: t(`apps.access.${value}`),
                    }))}
                    onChange={(value) => set({ access: value as typeof rules.access })}
                  />
                </FieldGroup>
                {rules.access !== 'none' && (
                  <>
                    <FieldGroup label={t('apps.hidden')}>
                      <MultiSelect
                        label={`${table.name} · ${t('apps.hidden')}`}
                        value={rules.hidden_fields ?? []}
                        options={table.fields.filter((f) => !f.is_primary).map((f) => ({ value: f.id, label: f.name }))}
                        onChange={(hidden_fields) => set({ hidden_fields })}
                      />
                    </FieldGroup>
                    <FieldGroup label={t('apps.rowRules')}>
                      <CardFilter
                        fields={table.fields}
                        filter={rules.rows ?? undefined}
                        onChange={(rows) => set({ rows })}
                      />
                    </FieldGroup>
                  </>
                )}
              </section>
            );
          })}
          <Button
            onClick={() => {
              onChange(roles.filter((r) => r.id !== role.id));
              setActive('');
            }}
          >
            {t('apps.delete')}
          </Button>
        </>
      )}
    </div>
  );
}
export function AudienceEditor({
  roles,
  value,
  onChange,
}: {
  roles: AppSpec['roles'];
  value: AppAudience[];
  onChange: (audience: AppAudience[]) => void;
}) {
  const t = useT();
  const { members } = usePeople();
  const groups = useQuery({ queryKey: ['groups', 'directory'], queryFn: () => api.members.groups() });
  const options = [
    { value: 'workspace:', label: t('apps.everyone') },
    ...members.map((m) => ({ value: `member:${m.id}`, label: m.name })),
    ...(groups.data?.items ?? []).map((g) => ({ value: `group:${g.id}`, label: g.name })),
  ];
  const keyOf = (grant: AppAudience) => `${grant.principal_type}:${grant.principal_id ?? ''}`;
  return (
    <div className="app-form">
      <p className="app-muted">{t('apps.baseRights')}</p>
      <FieldGroup label={t('apps.people')}>
        <MultiSelect
          label={t('apps.people')}
          value={value.map(keyOf)}
          options={options}
          onChange={(keys) =>
            onChange(
              keys.map(
                (key) =>
                  value.find((g) => keyOf(g) === key) ?? {
                    principal_type: key.split(':')[0] as AppAudience['principal_type'],
                    principal_id: key.split(':')[1] || null,
                    role: 'use',
                  },
              ),
            )
          }
        />
      </FieldGroup>
      {value.map((grant) => (
        <FieldGroup key={keyOf(grant)} label={options.find((o) => o.value === keyOf(grant))?.label ?? keyOf(grant)}>
          <Select
            label={t('apps.memberRole')}
            value={grant.role}
            options={[
              { value: 'use', label: t('apps.useRole') },
              ...roles.map((r) => ({ value: r.id, label: r.name })),
            ]}
            onChange={(role) => onChange(value.map((g) => (keyOf(g) === keyOf(grant) ? { ...g, role } : g)))}
          />
        </FieldGroup>
      ))}
    </div>
  );
}
