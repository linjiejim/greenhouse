/**
 * The buttons on a record (`AppRecordAction[]`, spec §2 / D8): a label, what
 * it does — update fields (fixed values or `$me` / `$today` / `$now`, plus
 * fields asked for in a dialog, some required), run one of the table's button
 * automations, or delete the record — who may press it, the precondition it
 * re-checks against the record when it runs (the place for "status is
 * pending" and "created by is not me"), and an optional confirmation.
 *
 * The editor says what the server would refuse before it is saved
 * (`actionProblems`), and warns when a role it applies to cannot edit a field
 * it writes (the server refuses to publish that — spec §2).
 */

import {
  APP_LIMITS,
  type AppRecordAction,
  type AppRecordActionEffect,
  type AppRole,
  type AppSpecError,
} from '@greenhouse/types/apps';
import { fieldAccessFor } from '@greenhouse/types/table-access';
import { Button, Checkbox, IconButton, Select } from '../../../../components/ui';
import { FormField } from '../../../../components/form';
import type { TableField, TableUserOption } from '../../../../lib/api/tables';
import { useT, type TranslationKey } from '../../../../lib/i18n';
import { ArrowDown, ArrowUp, Plus, Trash2 } from '../../../../lib/icons';
import { actionErrors } from '../spec-errors';
import { withList, writableFields, type BuilderButtonRule } from '../spec-model';
import { prefillableField } from '../../../../components/tables/field-values-editor';
import { ConditionEditor, RolesPicker, SpecErrorList, SpecValuesEditor, TextSetting } from './common';

export type ActionProblem = 'label' | 'nothing' | 'rule' | 'requiredNotAsked';

const PROBLEM_KEYS: Record<ActionProblem, TranslationKey> = {
  label: 'apps.builder.actions.problems.label',
  nothing: 'apps.builder.actions.problems.nothing',
  rule: 'apps.builder.actions.problems.rule',
  requiredNotAsked: 'apps.builder.actions.problems.requiredNotAsked',
};

/** What the server would refuse about one action, before saving (it re-checks everything). */
export function actionProblems(action: AppRecordAction, ruleIds: readonly number[]): ActionProblem[] {
  const problems: ActionProblem[] = [];
  if (!action.label.trim()) problems.push('label');
  if (action.do.type === 'set_fields') {
    if (action.do.values.length === 0 && (action.do.inputFieldIds ?? []).length === 0) problems.push('nothing');
    const asked = new Set(action.do.inputFieldIds ?? []);
    if ((action.do.requiredInputFieldIds ?? []).some((id) => !asked.has(id))) problems.push('requiredNotAsked');
  }
  if (action.do.type === 'run_automation' && !ruleIds.includes(action.do.ruleId)) problems.push('rule');
  return problems;
}

/** Roles the action applies to that cannot edit every field it writes (on this table). */
export function rolesThatCannotWrite(action: AppRecordAction, roles: readonly AppRole[], tableId: number): AppRole[] {
  if (action.do.type !== 'set_fields') return [];
  const keys = [...new Set([...action.do.values.map((entry) => entry.fieldId), ...(action.do.inputFieldIds ?? [])])];
  if (keys.length === 0) return [];
  return roles.filter((role) => {
    const rule = role.tables.find((entry) => entry.tableId === tableId);
    if (!rule || rule.access !== 'edit') return true;
    return keys.some((fieldId) => fieldAccessFor(rule, fieldId) !== 'edit');
  });
}

/** A new button: asks for one field so it is valid from the start (a builder then sets what it writes). */
export function newAction(id: string, label: string, fields: readonly TableField[]): AppRecordAction {
  const first = writableFields(fields).find(prefillableField);
  return {
    id,
    label,
    do: { type: 'set_fields', values: [], ...(first ? { inputFieldIds: [first.id] } : {}) },
  };
}

function effectFor(type: AppRecordActionEffect['type'], rules: readonly BuilderButtonRule[]): AppRecordActionEffect {
  if (type === 'run_automation') return { type, ruleId: rules[0]?.id ?? 0 };
  if (type === 'delete') return { type };
  return { type: 'set_fields', values: [] };
}

function ActionEditor({
  action,
  onChange,
  onRemove,
  onMove,
  first,
  last,
  fields,
  users,
  roles,
  pageRoles,
  rules,
  tableId,
  errors,
}: {
  action: AppRecordAction;
  onChange: (next: AppRecordAction) => void;
  onRemove: () => void;
  onMove: (by: -1 | 1) => void;
  first: boolean;
  last: boolean;
  fields: TableField[];
  users: TableUserOption[];
  /** All roles of the app (for the picker). */
  roles: readonly AppRole[];
  /** Roles that see the page (what "everyone" means here). */
  pageRoles: readonly AppRole[];
  rules: readonly BuilderButtonRule[];
  tableId: number;
  errors: readonly AppSpecError[];
}) {
  const t = useT();
  const writable = writableFields(fields).filter(prefillableField);
  const askable = writableFields(fields);
  const problems = actionProblems(
    action,
    rules.map((rule) => rule.id),
  );
  const applies = action.roles ? roles.filter((role) => action.roles!.includes(role.key)) : pageRoles;
  const blocked = rolesThatCannotWrite(action, applies, tableId);
  const effect = action.do;

  return (
    <li
      className="space-y-3 rounded-lg border border-edge bg-surface-raised p-3"
      data-testid={`app-action-${action.id}`}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <TextSetting
            required
            label={t('apps.builder.actions.label')}
            placeholder={t('apps.builder.actions.labelPlaceholder')}
            value={action.label}
            maxLength={APP_LIMITS.nameLength}
            onChange={(label) => label && onChange({ ...action, label })}
          />
        </div>
        <div className="mt-6 flex flex-shrink-0">
          <IconButton
            size="compact"
            label={t('apps.builder.actions.moveUp', { label: action.label })}
            disabled={first}
            onClick={() => onMove(-1)}
          >
            <ArrowUp size={12} />
          </IconButton>
          <IconButton
            size="compact"
            label={t('apps.builder.actions.moveDown', { label: action.label })}
            disabled={last}
            onClick={() => onMove(1)}
          >
            <ArrowDown size={12} />
          </IconButton>
          <IconButton
            size="compact"
            variant="destructive"
            label={t('apps.builder.actions.remove', { label: action.label })}
            onClick={onRemove}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      </div>

      <FormField label={t('apps.builder.actions.effect')}>
        <Select
          value={effect.type}
          onChange={(event) =>
            onChange({ ...action, do: effectFor(event.target.value as AppRecordActionEffect['type'], rules) })
          }
        >
          <option value="set_fields">{t('apps.builder.actions.effects.set_fields')}</option>
          {/* A rule id is required: without a button automation on the table there is nothing to pick. */}
          <option value="run_automation" disabled={rules.length === 0 && effect.type !== 'run_automation'}>
            {t('apps.builder.actions.effects.run_automation')}
          </option>
          <option value="delete">{t('apps.builder.actions.effects.delete')}</option>
        </Select>
      </FormField>
      {rules.length === 0 && effect.type !== 'run_automation' && (
        <p className="text-[11px] leading-4 text-fg-faint">{t('apps.builder.actions.noRules')}</p>
      )}

      {effect.type === 'set_fields' && (
        <>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">{t('apps.builder.actions.values')}</p>
            <SpecValuesEditor
              kind="action"
              entries={effect.values}
              onChange={(values) => onChange({ ...action, do: { ...effect, values } })}
              fields={writable}
              users={users}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-fg-muted">{t('apps.builder.actions.inputs')}</p>
            <p className="text-[11px] leading-4 text-fg-faint">{t('apps.builder.actions.inputsHint')}</p>
            <ul className="divide-y divide-edge rounded-md border border-edge">
              {askable.map((field) => {
                const asked = (effect.inputFieldIds ?? []).includes(field.id);
                const required = (effect.requiredInputFieldIds ?? []).includes(field.id);
                return (
                  <li key={field.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5">
                    <Checkbox
                      label={field.name}
                      checked={asked}
                      onChange={(event) => {
                        const inputs = event.target.checked
                          ? [...(effect.inputFieldIds ?? []), field.id]
                          : (effect.inputFieldIds ?? []).filter((id) => id !== field.id);
                        const requiredIds = (effect.requiredInputFieldIds ?? []).filter((id) => inputs.includes(id));
                        const next = withList(
                          withList(effect, 'inputFieldIds', inputs),
                          'requiredInputFieldIds',
                          requiredIds,
                        );
                        onChange({ ...action, do: next });
                      }}
                    />
                    {asked && (
                      <Checkbox
                        label={t('apps.builder.actions.required')}
                        checked={required}
                        onChange={(event) => {
                          const requiredIds = event.target.checked
                            ? [...(effect.requiredInputFieldIds ?? []), field.id]
                            : (effect.requiredInputFieldIds ?? []).filter((id) => id !== field.id);
                          onChange({ ...action, do: withList(effect, 'requiredInputFieldIds', requiredIds) });
                        }}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}

      {effect.type === 'run_automation' &&
        (rules.length === 0 ? (
          <p className="text-xs text-warning">{t('apps.builder.actions.noRules')}</p>
        ) : (
          <FormField label={t('apps.builder.actions.rule')} help={t('apps.builder.actions.ruleHint')}>
            <Select
              value={effect.ruleId || ''}
              onChange={(event) =>
                onChange({ ...action, do: { type: 'run_automation', ruleId: Number(event.target.value) } })
              }
            >
              {!rules.some((rule) => rule.id === effect.ruleId) && (
                <option value="">{t('apps.builder.actions.ruleChoose')}</option>
              )}
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.enabled ? rule.name : t('apps.builder.actions.ruleOff', { name: rule.name })}
                </option>
              ))}
            </Select>
          </FormField>
        ))}

      {effect.type === 'delete' && <p className="text-xs text-fg-muted">{t('apps.builder.actions.deleteHint')}</p>}

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-fg-muted">{t('apps.builder.actions.roles')}</p>
        <RolesPicker
          label={t('apps.builder.actions.roles')}
          roles={roles}
          value={action.roles}
          onChange={(next) => {
            const updated = { ...action };
            if (next === undefined) delete updated.roles;
            else updated.roles = next;
            onChange(updated);
          }}
        />
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium text-fg-muted">{t('apps.builder.actions.when')}</p>
        <p className="text-[11px] leading-4 text-fg-faint">{t('apps.builder.actions.whenHint')}</p>
        <ConditionEditor
          value={action.when}
          onChange={(when) => {
            const updated = { ...action };
            if (when) updated.when = when;
            else delete updated.when;
            onChange(updated);
          }}
          fields={fields}
          users={users}
          testId={`app-action-when-${action.id}`}
        />
      </div>

      <TextSetting
        label={t('apps.builder.actions.confirm')}
        value={action.confirm}
        maxLength={500}
        placeholder={t('apps.builder.actions.confirmPlaceholder')}
        onChange={(confirm) => {
          const updated = { ...action };
          if (confirm) updated.confirm = confirm;
          else delete updated.confirm;
          onChange(updated);
        }}
      />

      {problems.length > 0 && (
        <ul className="space-y-0.5 text-xs text-warning" data-testid={`app-action-problems-${action.id}`}>
          {problems.map((problem) => (
            <li key={problem}>{t(PROBLEM_KEYS[problem])}</li>
          ))}
        </ul>
      )}
      {blocked.length > 0 && (
        <p className="text-xs text-warning" data-testid={`app-action-blocked-${action.id}`}>
          {t('apps.builder.actions.rolesCannotWrite', { roles: blocked.map((role) => role.name).join(', ') })}
        </p>
      )}
      <SpecErrorList errors={actionErrors(errors, action.id)} />
    </li>
  );
}

export function ActionsEditor({
  actions,
  onChange,
  newId,
  fields,
  users,
  roles,
  pageRoles,
  rules,
  tableId,
  errors,
  testId,
}: {
  actions: readonly AppRecordAction[];
  onChange: (next: AppRecordAction[]) => void;
  /** The id the next new action gets (unique across the card). */
  newId: () => string;
  fields: TableField[];
  users: TableUserOption[];
  roles: readonly AppRole[];
  pageRoles: readonly AppRole[];
  /** Button automations of the card's table. */
  rules: readonly BuilderButtonRule[];
  tableId: number;
  /** The card's problems (filtered per action by id). */
  errors: readonly AppSpecError[];
  testId?: string;
}) {
  const t = useT();
  const move = (index: number, by: -1 | 1) => {
    const next = [...actions];
    const [action] = next.splice(index, 1);
    next.splice(index + by, 0, action!);
    onChange(next);
  };
  return (
    <div className="space-y-2" data-testid={testId}>
      {actions.length === 0 && <p className="text-xs text-fg-faint">{t('apps.builder.actions.none')}</p>}
      <ul className="space-y-2">
        {actions.map((action, index) => (
          <ActionEditor
            key={action.id}
            action={action}
            onChange={(next) => onChange(actions.map((entry, at) => (at === index ? next : entry)))}
            onRemove={() => onChange(actions.filter((_, at) => at !== index))}
            onMove={(by) => move(index, by)}
            first={index === 0}
            last={index === actions.length - 1}
            fields={fields}
            users={users}
            roles={roles}
            pageRoles={pageRoles}
            rules={rules}
            tableId={tableId}
            errors={errors}
          />
        ))}
      </ul>
      {actions.length < APP_LIMITS.actionsPerCard && (
        <Button
          variant="outline"
          size="sm"
          onClick={() => onChange([...actions, newAction(newId(), t('apps.builder.actions.newLabel'), fields)])}
        >
          <Plus size={13} className="mr-1.5" />
          {t('apps.builder.actions.add')}
        </Button>
      )}
    </div>
  );
}
