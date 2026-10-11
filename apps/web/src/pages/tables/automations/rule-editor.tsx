/**
 * The automation rule editor: when (trigger + its settings), only if (the one
 * `FilterEditor`), then (an ordered list of actions). Shown inside the
 * workspace-size automations dialog in place of the rule list.
 *
 * The draft model and every pre-save check live in ./rule-draft (pure); the
 * server re-validates and its message is shown when it refuses.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  automationTriggerHasActor,
  automationTriggerHasRecord,
  TABLE_AUTOMATION_TRIGGERS,
  type TableAutomationTrigger,
} from '@greenhouse/types/tables';
import { Button, IconButton, Input, Select, Spinner, Toggle } from '../../../components/ui';
import { FormActions, FormError, FormField, FormGrid, FormGroup, FormSection } from '../../../components/form';
import { FilterEditor } from '../../../components/tables/filter-editor';
import { ScheduleBuilder } from '../../../components/schedule-builder';
import {
  createTableAutomation,
  getTableSchema,
  updateTableAutomation,
  type TableAutomation,
  type TableDefinition,
  type TableField,
  type TableUserOption,
} from '../../../lib/api/tables';
import { localTimeZone } from '../../../lib/cron';
import { ArrowDown, ArrowLeft, ArrowUp, Trash2 } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import { ActionEditor, FieldChecklist, type ActionEditorContext } from './action-editors';
import {
  ACTION_LABEL_KEYS,
  ACTION_TYPES,
  draftToInput,
  newActionDraft,
  newRuleDraft,
  ruleToDraft,
  type ActionDraft,
  type ActionType,
  type DraftProblem,
  type RuleDraft,
  TRIGGER_LABEL_KEYS,
} from './rule-draft';

/** Tables a rule needs the fields of: its own, and every create_record target. */
function tablesOf(rule: TableAutomation): number[] {
  const ids = new Set([rule.table_id]);
  for (const action of rule.config.actions) if (action.type === 'create_record') ids.add(action.tableId);
  return [...ids];
}

export function RuleEditor({
  baseId,
  tables,
  users,
  rule,
  onCancel,
  onSaved,
}: {
  baseId: number;
  tables: readonly TableDefinition[];
  users: TableUserOption[];
  /** null = a new rule. */
  rule: TableAutomation | null;
  onCancel: () => void;
  onSaved: (saved: TableAutomation) => void;
}) {
  const t = useT();
  const [fieldsByTable, setFieldsByTable] = useState<ReadonlyMap<number, readonly TableField[]>>(new Map());
  const [draft, setDraft] = useState<RuleDraft | null>(null);
  const [problem, setProblem] = useState<DraftProblem | null>(null);
  const [serverError, setServerError] = useState('');
  const [saving, setSaving] = useState(false);
  const requested = useRef(new Set<number>());

  const needFields = useCallback(async (tableId: number) => {
    if (requested.current.has(tableId)) return;
    requested.current.add(tableId);
    try {
      const schema = await getTableSchema(tableId);
      setFieldsByTable((current) => new Map(current).set(tableId, schema.fields));
    } catch {
      requested.current.delete(tableId);
    }
  }, []);

  // A stored rule becomes a draft only once the fields its values refer to are known.
  useEffect(() => {
    let cancelled = false;
    const tableIds = rule ? tablesOf(rule) : tables[0] ? [tables[0].id] : [];
    void Promise.all(tableIds.map(async (tableId) => [tableId, (await getTableSchema(tableId)).fields] as const))
      .then((entries) => {
        if (cancelled) return;
        entries.forEach(([tableId]) => requested.current.add(tableId));
        const loaded = new Map(entries);
        setFieldsByTable(loaded);
        setDraft(
          rule
            ? ruleToDraft(rule, loaded, localTimeZone())
            : newRuleDraft({ tableId: tables[0]?.id ?? null, timezone: localTimeZone() }),
        );
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setServerError(error instanceof Error ? error.message : t('tables.automations.loadFailed'));
        setDraft(
          rule
            ? ruleToDraft(rule, new Map(), localTimeZone())
            : newRuleDraft({ tableId: tables[0]?.id ?? null, timezone: localTimeZone() }),
        );
      });
    return () => {
      cancelled = true;
    };
  }, [rule, tables, t]);

  const fields = useMemo<TableField[]>(
    () => (draft?.tableId != null ? [...(fieldsByTable.get(draft.tableId) ?? [])] : []),
    [draft?.tableId, fieldsByTable],
  );

  if (!draft) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-xs text-fg-muted">
        <Spinner />
        {t('tables.automations.loadingFields')}
      </div>
    );
  }

  const update = (patch: Partial<RuleDraft>) => {
    setProblem(null);
    setDraft((current) => (current ? { ...current, ...patch } : current));
  };
  const updateAction = (index: number, next: ActionDraft) =>
    update({ actions: draft.actions.map((action, i) => (i === index ? next : action)) });
  const moveAction = (index: number, delta: number) => {
    const actions = [...draft.actions];
    const [moved] = actions.splice(index, 1);
    actions.splice(index + delta, 0, moved!);
    update({ actions });
  };

  const hasRecord = automationTriggerHasRecord(draft.trigger, {
    cron: draft.cron,
    timezone: draft.timezone,
    scope: draft.scope,
  });
  const hasActor = automationTriggerHasActor(draft.trigger);
  const dateFields = fields.filter((field) => field.type === 'date' || field.type === 'datetime');
  const dateField = dateFields.find((field) => field.id === draft.dateFieldId);
  const addable = ACTION_TYPES.filter((type) => hasRecord || type !== 'update_record');
  const context: ActionEditorContext = {
    trigger: draft.trigger,
    hasRecord,
    hasActor,
    fields,
    fieldsByTable,
    tables,
    users,
    baseId,
    needFields: (tableId) => void needFields(tableId),
  };

  const save = async () => {
    const result = draftToInput(draft, fieldsByTable);
    if (!result.ok) {
      setProblem(result.problem);
      return;
    }
    setSaving(true);
    setServerError('');
    try {
      const saved = rule
        ? await updateTableAutomation(rule.id, {
            revision: rule.revision,
            name: result.input.name,
            status: result.input.status,
            trigger: result.input.trigger,
            config: result.input.config,
          })
        : await createTableAutomation(baseId, result.input);
      onSaved(saved);
    } catch (error) {
      setServerError(error instanceof Error ? error.message : t('tables.automations.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4" data-testid="automation-rule-editor">
      <div className="flex items-center gap-2">
        <IconButton label={t('tables.automations.back')} size="compact" onClick={onCancel}>
          <ArrowLeft size={15} />
        </IconButton>
        <h4 className="text-sm font-semibold text-fg">
          {rule ? t('tables.automations.editTitle') : t('tables.automations.newTitle')}
        </h4>
      </div>

      <FormGrid columns={3}>
        <FormField label={t('tables.automations.ruleName')} required>
          <Input
            value={draft.name}
            placeholder={t('tables.automations.ruleNamePlaceholder')}
            onChange={(event) => update({ name: event.target.value })}
          />
        </FormField>
        <FormField label={t('tables.automations.table')} required>
          <Select
            value={draft.tableId ?? ''}
            disabled={rule !== null}
            onChange={(event) => {
              const tableId = Number(event.target.value);
              void needFields(tableId);
              update({ tableId, condition: { combinator: 'and', clauses: [] }, watchFieldIds: [], dateFieldId: null });
            }}
          >
            {tables.map((table) => (
              <option key={table.id} value={table.id}>
                {table.name}
              </option>
            ))}
          </Select>
        </FormField>
        <FormGroup label={t('tables.automations.enabled')}>
          <Toggle
            checked={draft.enabled}
            label={t('tables.automations.enabled')}
            onChange={(enabled) => update({ enabled })}
          />
        </FormGroup>
      </FormGrid>

      <FormSection title={t('tables.automations.sectionWhen')}>
        <div className="space-y-3">
          <FormField label={t('tables.automations.sectionWhen')} className="max-w-md">
            <Select
              value={draft.trigger}
              data-testid="automation-trigger"
              onChange={(event) => update({ trigger: event.target.value as TableAutomationTrigger })}
            >
              {TABLE_AUTOMATION_TRIGGERS.map((trigger) => (
                <option key={trigger} value={trigger}>
                  {t(TRIGGER_LABEL_KEYS[trigger])}
                </option>
              ))}
            </Select>
          </FormField>

          {draft.trigger === 'record_updated' && (
            <FormGroup label={t('tables.automations.watchFields')} help={t('tables.automations.watchFieldsHelp')}>
              <FieldChecklist
                fields={fields}
                selected={draft.watchFieldIds}
                onChange={(watchFieldIds) => update({ watchFieldIds })}
              />
            </FormGroup>
          )}

          {draft.trigger === 'schedule' && (
            <div className="space-y-3">
              <FormGroup label={t('tables.automations.scheduleRepeat')} help={t('tables.automations.scheduleHelp')}>
                <ScheduleBuilder value={draft.cron} onChange={(cron) => update({ cron })} />
              </FormGroup>
              <FormGrid>
                <FormField label={t('tables.automations.timezone')}>
                  <Input value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })} />
                </FormField>
                <FormField label={t('tables.automations.scheduleScope')}>
                  <Select
                    value={draft.scope}
                    onChange={(event) => update({ scope: event.target.value as RuleDraft['scope'] })}
                  >
                    <option value="once">{t('tables.automations.scopeOnce')}</option>
                    <option value="records">{t('tables.automations.scopeRecords')}</option>
                  </Select>
                </FormField>
              </FormGrid>
            </div>
          )}

          {draft.trigger === 'date_reached' &&
            (dateFields.length === 0 ? (
              <p className="text-xs text-fg-muted">{t('tables.automations.noDateFields')}</p>
            ) : (
              <div className="space-y-2">
                <FormGrid columns={3}>
                  <FormField label={t('tables.automations.dateField')}>
                    <Select
                      value={draft.dateFieldId ?? ''}
                      onChange={(event) =>
                        update({ dateFieldId: event.target.value ? Number(event.target.value) : null })
                      }
                    >
                      <option value="">—</option>
                      {dateFields.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                    </Select>
                  </FormField>
                  <FormField label={t('tables.automations.dateOffset')}>
                    <Input
                      type="number"
                      step={1}
                      value={draft.offsetDays}
                      onChange={(event) => update({ offsetDays: event.target.value })}
                    />
                  </FormField>
                  {dateField?.type !== 'datetime' && (
                    <FormField label={t('tables.automations.dateTime')}>
                      <Input
                        type="time"
                        value={draft.time}
                        onChange={(event) => event.target.value && update({ time: event.target.value })}
                      />
                    </FormField>
                  )}
                </FormGrid>
                <FormGrid>
                  <FormField label={t('tables.automations.timezone')}>
                    <Input value={draft.timezone} onChange={(event) => update({ timezone: event.target.value })} />
                  </FormField>
                </FormGrid>
                <p className="text-[11px] leading-4 text-fg-faint">
                  {t('tables.automations.dateHelp')}{' '}
                  {dateField?.type === 'datetime' && t('tables.automations.dateTimeIgnored')}
                </p>
              </div>
            ))}

          {draft.trigger === 'button' && (
            <FormField
              label={t('tables.automations.buttonLabel')}
              help={t('tables.automations.buttonHelp')}
              className="max-w-sm"
            >
              <Input
                value={draft.buttonLabel}
                maxLength={40}
                onChange={(event) => update({ buttonLabel: event.target.value })}
              />
            </FormField>
          )}
        </div>
      </FormSection>

      {hasRecord && (
        <FormSection
          title={t('tables.automations.sectionCondition')}
          description={
            draft.trigger === 'record_matched'
              ? t('tables.automations.conditionRequiredHelp')
              : t('tables.automations.conditionHelp')
          }
        >
          <FilterEditor
            value={draft.condition}
            onChange={(condition) => update({ condition })}
            fields={fields}
            users={users}
          />
        </FormSection>
      )}

      <FormSection title={t('tables.automations.sectionThen')}>
        <ol className="space-y-3">
          {draft.actions.map((action, index) => (
            <li
              key={action.key}
              className="rounded-lg border border-edge bg-surface-sunken p-3"
              data-testid={`automation-action-${index}`}
            >
              <div className="mb-3 flex items-center gap-2">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-fg-faint">
                  {t('tables.automations.step', { n: index + 1 })}
                </span>
                <span className="text-sm font-medium text-fg">{t(ACTION_LABEL_KEYS[action.type])}</span>
                <span className="flex-1" />
                <IconButton
                  label={t('tables.automations.moveUp')}
                  size="compact"
                  disabled={index === 0}
                  onClick={() => moveAction(index, -1)}
                >
                  <ArrowUp size={14} />
                </IconButton>
                <IconButton
                  label={t('tables.automations.moveDown')}
                  size="compact"
                  disabled={index === draft.actions.length - 1}
                  onClick={() => moveAction(index, 1)}
                >
                  <ArrowDown size={14} />
                </IconButton>
                <IconButton
                  label={t('tables.automations.removeAction')}
                  size="compact"
                  variant="destructive"
                  onClick={() => update({ actions: draft.actions.filter((_, i) => i !== index) })}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
              <ActionEditor action={action} context={context} onChange={(next) => updateAction(index, next)} />
            </li>
          ))}
        </ol>
        {draft.actions.length < 10 && (
          <Select
            className="mt-3"
            size="sm"
            inline
            value=""
            aria-label={t('tables.automations.addAction')}
            data-testid="automation-add-action"
            onChange={(event) => {
              const type = event.target.value as ActionType;
              if (type) update({ actions: [...draft.actions, newActionDraft(type, draft.tableId)] });
            }}
          >
            <option value="">{t('tables.automations.addAction')}</option>
            {addable.map((type) => (
              <option key={type} value={type}>
                {t(ACTION_LABEL_KEYS[type])}
              </option>
            ))}
          </Select>
        )}
      </FormSection>

      <FormError>
        {problem ? t(problem.key, problem.step !== undefined ? { n: problem.step } : undefined) : serverError}
      </FormError>
      <FormActions>
        <Button variant="ghost" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button disabled={saving} onClick={() => void save()} data-testid="automation-save">
          {saving ? t('tables.automations.saving') : t('tables.automations.save')}
        </Button>
      </FormActions>
    </div>
  );
}
