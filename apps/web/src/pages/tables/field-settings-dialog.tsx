/**
 * Field settings: create a field or change one (name, required, options,
 * relation target, formula text, rollup, lookup). Removing select options an
 * app uses answers 409 `used_by_apps` (D6): the references open over the
 * dialog, and "Save anyway" resends the change with `confirm`.
 */

import { useAuthStore } from '../../stores';
import { canUseFeature } from '../../lib/features';
import { AiFieldEditor, AiFieldRuns, emptyAiConfig } from './ai-field-editor';
import React, { useEffect, useMemo, useState } from 'react';
import {
  formatTableFormula,
  parseTableFormula,
  suggestedTableFormulaResultType,
} from '@greenhouse/types/table-formula';
import {
  isComputedFieldType,
  TABLE_LOOKUP_TARGET_TYPES,
  type TableFieldConfig,
  type TableFieldType,
  type TableFormulaResultType,
  type TableRollupAggregation,
} from '@greenhouse/types/tables';
import { Button, Checkbox, Dialog, Input, Select } from '../../components/ui';
import { FormField, FormGroup } from '../../components/form';
import { AppReferencesDialog, useAppReferencesGuard } from '../../components/tables/app-references';
import { CREATABLE_FIELD_TYPES, FIELD_TYPE_LABEL_KEYS, fieldConfig } from '../../components/tables/field-types';
import { Archive } from '../../lib/icons';
import {
  createTableField,
  getTableSchema,
  updateTableField,
  type TableDefinition,
  type TableField,
} from '../../lib/api/tables';
import { useT } from '../../lib/i18n';
import { FormulaEditor, useFormulaErrorText } from './formula-editor';
import { optionRows, optionsFromRows, type OptionRow } from './option-list';
import { OptionListEditor } from './option-list-editor';

const LOOKUP_TARGETS: readonly string[] = TABLE_LOOKUP_TARGET_TYPES;

interface FieldSettingsDialogProps {
  /** `'new'` to create, a field to edit, `null` when closed. */
  field: TableField | 'new' | null;
  table: TableDefinition;
  tables: TableDefinition[];
  /** The table's current fields (formula operands, rollup relations). */
  fields: TableField[];
  onClose: () => void;
  onSaved: () => Promise<void>;
  onArchive: (field: TableField) => void;
}

export function FieldSettingsDialog({
  field,
  table,
  tables,
  fields,
  onClose,
  onSaved,
  onArchive,
}: FieldSettingsDialogProps) {
  const t = useT();
  const currentUser = useAuthStore((state) => state.currentUser);
  const aiAllowed = canUseFeature(currentUser, 'tables_ai_fields');
  const creatableTypes = CREATABLE_FIELD_TYPES.filter((entry) => entry !== 'ai' || aiAllowed);
  const [ai, setAi] = useState(emptyAiConfig);
  const [name, setName] = useState('');
  const [type, setType] = useState<TableFieldType>('text');
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState<OptionRow[]>([]);
  const [relationTargetTableId, setRelationTargetTableId] = useState<number | ''>('');
  const [relationMultiple, setRelationMultiple] = useState(false);
  const [formulaText, setFormulaText] = useState('');
  const [formulaResultType, setFormulaResultType] = useState<TableFormulaResultType>('text');
  // A new formula's result type follows what the formula returns until the builder picks one.
  const [resultTypeChosen, setResultTypeChosen] = useState(false);
  // The stored formula as the dialog opened on it (null for new fields).
  const [storedFormula, setStoredFormula] = useState<{ text: string; resultType: TableFormulaResultType } | null>(null);
  // Rollups and lookups both read one field of the records linked through a relation.
  const [linkRelationFieldId, setLinkRelationFieldId] = useState<number | ''>('');
  const [linkTargetFieldId, setLinkTargetFieldId] = useState<number | ''>('');
  const [rollupAggregation, setRollupAggregation] = useState<TableRollupAggregation>('count');
  const [targetFields, setTargetFields] = useState<TableField[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const formulaErrorText = useFormulaErrorText();
  const appReferences = useAppReferencesGuard();

  // What a formula may name: this table's fields, never the one being edited.
  const formulaFields = useMemo(
    () =>
      fields
        .filter((entry) => field === 'new' || field === null || entry.id !== field.id)
        .map(({ id, name, type: fieldType }) => ({ id, name, type: fieldType })),
    [field, fields],
  );

  useEffect(() => {
    if (!field) return;
    const config = field === 'new' ? {} : fieldConfig(field);
    const link = config.rollup ?? config.lookup;
    setAi(config.ai ?? emptyAiConfig());
    setName(field === 'new' ? '' : field.name);
    setType(field === 'new' ? 'text' : field.type);
    setRequired(field === 'new' ? false : field.required);
    setOptions(optionRows(config.options));
    setRelationTargetTableId(config.relation?.targetTableId ?? '');
    setRelationMultiple(config.relation?.multiple === true);
    const storedText = config.formula ? formatTableFormula(config.formula.expression, fields) : '';
    setFormulaText(storedText);
    setFormulaResultType(config.formula?.resultType ?? 'text');
    setResultTypeChosen(config.formula !== undefined);
    setStoredFormula(config.formula ? { text: storedText, resultType: config.formula.resultType } : null);
    setLinkRelationFieldId(link?.relationFieldId ?? '');
    setLinkTargetFieldId(link?.targetFieldId ?? '');
    setRollupAggregation(config.rollup?.aggregation ?? 'count');
    setError('');
    // Only when the dialog opens on a field: re-formatting on every schema refresh would undo typing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [field]);

  const parsedFormula = useMemo(
    () => (type === 'formula' ? parseTableFormula(formulaText, formulaFields) : null),
    [formulaFields, formulaText, type],
  );

  useEffect(() => {
    if (resultTypeChosen || !parsedFormula?.ok) return;
    const suggested = suggestedTableFormulaResultType(parsedFormula.type);
    if (suggested) setFormulaResultType(suggested);
  }, [parsedFormula, resultTypeChosen]);

  const relationFields = useMemo(() => fields.filter((entry) => entry.type === 'relation'), [fields]);
  const linkTargetTableId = useMemo(() => {
    const relationField = relationFields.find((entry) => entry.id === linkRelationFieldId);
    return relationField ? fieldConfig(relationField).relation?.targetTableId : undefined;
  }, [relationFields, linkRelationFieldId]);
  const linkTargetChoices = useMemo(
    () => (type === 'lookup' ? targetFields.filter((entry) => LOOKUP_TARGETS.includes(entry.type)) : targetFields),
    [targetFields, type],
  );

  useEffect(() => {
    const targetTableId =
      type === 'relation'
        ? relationTargetTableId || undefined
        : type === 'rollup' || type === 'lookup'
          ? linkTargetTableId
          : undefined;
    if (!targetTableId) {
      setTargetFields([]);
      return;
    }
    let cancelled = false;
    void getTableSchema(targetTableId)
      .then((schema) => {
        if (!cancelled) setTargetFields(schema.fields);
      })
      .catch(() => {
        if (!cancelled) setTargetFields([]);
      });
    return () => {
      cancelled = true;
    };
  }, [type, relationTargetTableId, linkTargetTableId]);

  const buildConfig = (): TableFieldConfig | undefined => {
    if (type === 'ai')
      return {
        ai: {
          ...ai,
          ...(['single_select', 'multi_select'].includes(ai.resultType)
            ? { options: optionsFromRows(options, field && field !== 'new' ? fieldConfig(field).options : []) }
            : {}),
        },
      };
    if (type === 'single_select' || type === 'multi_select') {
      // Rows carry their stored option: ids follow options, never line positions.
      return { options: optionsFromRows(options, field && field !== 'new' ? fieldConfig(field).options : []) };
    }
    if (type === 'relation' && relationTargetTableId !== '') {
      return { relation: { targetTableId: relationTargetTableId, multiple: relationMultiple } };
    }
    if (type === 'formula' && parsedFormula?.ok) {
      return { formula: { resultType: formulaResultType, expression: parsedFormula.expression } };
    }
    if (type === 'rollup' && linkRelationFieldId !== '' && linkTargetFieldId !== '') {
      return {
        rollup: {
          relationFieldId: linkRelationFieldId,
          targetFieldId: linkTargetFieldId,
          aggregation: rollupAggregation,
        },
      };
    }
    if (type === 'lookup' && linkRelationFieldId !== '' && linkTargetFieldId !== '') {
      return { lookup: { relationFieldId: linkRelationFieldId, targetFieldId: linkTargetFieldId } };
    }
    return undefined;
  };

  const save = async () => {
    if (!field || !name.trim()) return;
    setSaving(true);
    setError('');
    try {
      // A stored formula left as it was is not sent again, so renaming a field
      // whose older formula fails today's checks still works.
      const formulaUntouched =
        type === 'formula' &&
        storedFormula !== null &&
        formulaText === storedFormula.text &&
        formulaResultType === storedFormula.resultType;
      if (type === 'formula' && !formulaUntouched && parsedFormula && !parsedFormula.ok && formulaText.trim()) {
        throw new Error(t('tables.formula.fixBeforeSaving', { message: formulaErrorText(parsedFormula.error) }));
      }
      const config = formulaUntouched ? undefined : buildConfig();
      if (!formulaUntouched && (type === 'relation' || isComputedFieldType(type)) && !config) {
        throw new Error(t('tables.completeFieldConfiguration', { type: t(FIELD_TYPE_LABEL_KEYS[type]) }));
      }
      if (field === 'new') {
        await createTableField(table.id, {
          name: name.trim(),
          type,
          required: isComputedFieldType(type) ? false : required,
          config,
        });
        await onSaved();
      } else {
        const input = { name: name.trim(), required, config };
        const editing = field;
        // Dropping options an app uses asks first; this dialog stays open until it is settled.
        await appReferences.guard(
          async (confirm) => {
            await (confirm
              ? updateTableField(editing.id, input, { confirm: true })
              : updateTableField(editing.id, input));
            await onSaved();
          },
          {
            title: t('apps.builder.references.optionsTitle', { name: editing.name }),
            confirmLabel: t('apps.builder.references.saveAnyway'),
          },
        );
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('tables.saveFieldFailed'));
    } finally {
      setSaving(false);
    }
  };

  const idSelect = (
    value: number | '',
    onChange: (next: number | '') => void,
    placeholder: string,
    choices: Array<{ id: number; name: string }>,
    disabled = false,
  ) => (
    <Select
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value ? Number(event.target.value) : '')}
    >
      <option value="">{placeholder}</option>
      {choices.map((entry) => (
        <option key={entry.id} value={entry.id}>
          {entry.name}
        </option>
      ))}
    </Select>
  );

  return (
    <>
      <Dialog
        open={field !== null}
        onClose={onClose}
        title={field === 'new' ? t('tables.newField') : t('tables.fieldSettings')}
      >
        <div className="space-y-4">
          <FormField label={t('common.name')}>
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <FormField label={t('tables.type')}>
            <Select
              value={type}
              disabled={field !== 'new'}
              onChange={(event) => setType(event.target.value as TableFieldType)}
            >
              {/* An existing field keeps showing its own type even when it is not creatable here. */}
              {(creatableTypes.includes(type) ? creatableTypes : [type, ...creatableTypes]).map((entry) => (
                <option key={entry} value={entry}>
                  {t(FIELD_TYPE_LABEL_KEYS[entry])}
                </option>
              ))}
            </Select>
          </FormField>
          <Checkbox
            label={t('tables.required')}
            checked={required}
            disabled={isComputedFieldType(type)}
            onChange={(event) => setRequired(event.target.checked)}
          />
          {type === 'ai' && <AiFieldEditor value={ai} onChange={setAi} fields={fields} />}
          {type === 'ai' && aiAllowed && field && field !== 'new' && <AiFieldRuns fieldId={field.id} />}
          {(type === 'single_select' ||
            type === 'multi_select' ||
            (type === 'ai' && ['single_select', 'multi_select'].includes(ai.resultType))) && (
            <FormGroup label={t('tables.fieldOptions.title')} help={t('tables.fieldOptions.hint')}>
              <OptionListEditor rows={options} onChange={setOptions} />
            </FormGroup>
          )}
          {type === 'relation' && (
            <div className="space-y-3 rounded-md border border-edge bg-surface-sunken p-3">
              <FormField label={t('tables.relatedTable')}>
                {idSelect(relationTargetTableId, setRelationTargetTableId, t('tables.chooseTable'), tables)}
              </FormField>
              <Checkbox
                label={t('tables.allowMultipleRelations')}
                checked={relationMultiple}
                onChange={(event) => setRelationMultiple(event.target.checked)}
              />
            </div>
          )}
          {type === 'formula' && parsedFormula && (
            <div className="space-y-3 rounded-md border border-edge bg-surface-sunken p-3">
              <FormField label={t('tables.formula.editorLabel')}>
                <FormulaEditor
                  value={formulaText}
                  onChange={setFormulaText}
                  fields={formulaFields}
                  result={parsedFormula}
                />
              </FormField>
              <FormField label={t('tables.resultType')}>
                <Select
                  value={formulaResultType}
                  onChange={(event) => {
                    setResultTypeChosen(true);
                    setFormulaResultType(event.target.value as TableFormulaResultType);
                  }}
                >
                  <option value="text">{t('tables.fieldType.text')}</option>
                  <option value="number">{t('tables.fieldType.number')}</option>
                  <option value="boolean">{t('tables.fieldType.booleanValue')}</option>
                  <option value="date">{t('tables.fieldType.date')}</option>
                  <option value="datetime">{t('tables.fieldType.datetime')}</option>
                </Select>
              </FormField>
              <p className="text-[11px] text-fg-faint">{t('tables.formulaSafety')}</p>
            </div>
          )}
          {(type === 'rollup' || type === 'lookup') && (
            <div className="grid grid-cols-1 gap-3 rounded-md border border-edge bg-surface-sunken p-3 sm:grid-cols-2">
              <FormField label={t('tables.relationField')}>
                {idSelect(
                  linkRelationFieldId,
                  (next) => {
                    setLinkRelationFieldId(next);
                    setLinkTargetFieldId('');
                  },
                  t('tables.chooseRelation'),
                  relationFields,
                )}
              </FormField>
              <FormField label={t('tables.targetField')}>
                {idSelect(
                  linkTargetFieldId,
                  setLinkTargetFieldId,
                  t('tables.chooseTargetField'),
                  linkTargetChoices,
                  !linkTargetTableId,
                )}
              </FormField>
              {type === 'rollup' ? (
                <FormField label={t('tables.aggregation')} className="sm:col-span-2">
                  <Select
                    value={rollupAggregation}
                    onChange={(event) => setRollupAggregation(event.target.value as TableRollupAggregation)}
                  >
                    <option value="count">{t('tables.aggregationType.count')}</option>
                    <option value="sum">{t('tables.aggregationType.sum')}</option>
                    <option value="avg">{t('tables.aggregationType.avg')}</option>
                    <option value="min">{t('tables.aggregationType.min')}</option>
                    <option value="max">{t('tables.aggregationType.max')}</option>
                    <option value="join">{t('tables.aggregationType.join')}</option>
                  </Select>
                </FormField>
              ) : (
                <p className="text-[11px] text-fg-faint sm:col-span-2">{t('tables.formula.lookupHint')}</p>
              )}
            </div>
          )}
          {error && <p className="text-xs text-danger">{error}</p>}
          <div className="flex items-center justify-between border-t border-edge pt-4">
            {field && field !== 'new' && !field.is_primary ? (
              <Button variant="ghost" className="text-danger" onClick={() => onArchive(field)}>
                <Archive size={13} className="mr-1.5" />
                {t('common.archive')}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="ghost" onClick={onClose}>
                {t('common.cancel')}
              </Button>
              <Button onClick={() => void save()} disabled={saving || !name.trim()}>
                {saving ? t('common.saving') : t('tables.saveField')}
              </Button>
            </div>
          </div>
        </div>
      </Dialog>
      <AppReferencesDialog request={appReferences.request} onClose={appReferences.close} />
    </>
  );
}
