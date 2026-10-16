/** Computed field settings use the contract's references, function catalog and limits. */
import { useEffect, useRef, useState } from 'react';
import { Checkbox, Field, FieldGroup, HelpHint, Select, TextArea } from '@greenhouse/ui/kit';
import {
  AI_PROMPT_MAX,
  FORMULA_TEXT_MAX,
  FORMULA_CATALOG,
  FORMULA_MAX_ARGS,
  FORMULA_FUNCTIONS,
  ROLLUP_AGGREGATES,
  formulaFieldRef,
  isLinkType,
  type Base,
  type BaseTable,
  type FieldConfig,
  type FormulaError,
  type FieldType,
} from '@greenhouse/contract';
import { useI18n } from '../../lib/i18n';

export function ComputedEditor({
  base,
  table,
  fieldId,
  type,
  config,
  onChange,
  error,
}: {
  base: Base;
  table: BaseTable;
  fieldId?: string;
  type: FieldType;
  config: FieldConfig;
  onChange: (next: FieldConfig) => void;
  error?: FormulaError;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (error) {
      input.current?.focus();
      input.current?.setSelectionRange(error.start, error.end);
    }
  }, [error]);
  const [fn, setFn] = useState<(typeof FORMULA_FUNCTIONS)[number]>('if');
  const text = type === 'ai' ? (config.prompt ?? '') : (config.formula_text ?? '');
  const insert = (part: string) => {
    const start = input.current?.selectionStart ?? text.length;
    const end = input.current?.selectionEnd ?? start;
    const next = text.slice(0, start) + part + text.slice(end);
    if (next.length > (type === 'ai' ? AI_PROMPT_MAX : FORMULA_TEXT_MAX)) return;
    onChange({ ...config, [type === 'ai' ? 'prompt' : 'formula_text']: next });
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(start + part.length, start + part.length);
    });
  };
  if (type === 'formula' || type === 'ai')
    return (
      <>
        <Field
          label={t(type === 'ai' ? 'tables.computed.prompt' : 'tables.computed.formula')}
          error={error ? t(`tables.formula.error.${error.code}`, { ...error.params, at: error.start + 1 }) : undefined}
        >
          <TextArea
            ref={input}
            rows={5}
            className="app-tb-expression"
            value={text}
            maxLength={type === 'ai' ? AI_PROMPT_MAX : FORMULA_TEXT_MAX}
            onChange={(event) =>
              onChange({ ...config, [type === 'ai' ? 'prompt' : 'formula_text']: event.target.value })
            }
          />
        </Field>
        {error && (
          <code className="app-tb-error-excerpt">
            {text.slice(0, error.start)}
            <mark>{text.slice(error.start, error.end) || ' '}</mark>
            {text.slice(error.end)}
          </code>
        )}
        <FieldGroup label={t('tables.computed.insertField')}>
          <Select
            label={t('tables.computed.insertField')}
            value=""
            placeholder={t('tables.computed.insertField')}
            options={table.fields
              .filter((field) => field.id !== fieldId)
              .map((field) => ({ value: field.id, label: field.name }))}
            onChange={(id) => {
              const field = table.fields.find((entry) => entry.id === id);
              if (field) insert(formulaFieldRef(field.name));
            }}
          />
        </FieldGroup>
        {type === 'formula' ? (
          <FieldGroup label={t('tables.computed.functions')}>
            <div className="app-inline-actions">
              <Select
                label={t('tables.computed.functions')}
                value={fn}
                options={FORMULA_FUNCTIONS.map((value) => ({ value, label: value.toUpperCase() }))}
                onChange={(next) => {
                  setFn(next as typeof fn);
                  insert(`${next.toUpperCase()}()`);
                }}
              />
              <HelpHint label={t('tables.computed.functionHelp')}>
                {t(`tables.formula.function.${fn}`)}{' '}
                {t('tables.computed.arguments', {
                  min: FORMULA_CATALOG[fn].minArgs,
                  max: FORMULA_CATALOG[fn].maxArgs ?? FORMULA_MAX_ARGS,
                })}
              </HelpHint>
            </div>
          </FieldGroup>
        ) : (
          <Checkbox
            label={t('tables.computed.autoUpdate')}
            checked={config.auto_update ?? true}
            onChange={(auto_update) => onChange({ ...config, auto_update })}
          />
        )}
      </>
    );
  const links = table.fields.filter((field) => isLinkType(field.type));
  const link = links.find((field) => field.id === config.link_field);
  const target = base.tables.find(
    (entry) => entry.id === (link?.type === 'relation' ? link.config.table_id : table.id),
  );
  return (
    <>
      <FieldGroup label={t('tables.computed.relation')}>
        <Select
          label={t('tables.computed.relation')}
          value={config.link_field ?? ''}
          options={links.map((field) => ({ value: field.id, label: field.name }))}
          onChange={(link_field) => onChange({ ...config, link_field, target_field: undefined })}
        />
      </FieldGroup>
      <FieldGroup label={t('tables.computed.target')}>
        <Select
          label={t('tables.computed.target')}
          value={config.target_field ?? ''}
          disabled={!link}
          options={(target?.fields ?? [])
            .filter((field) => field.id !== fieldId)
            .map((field) => ({ value: field.id, label: field.name }))}
          onChange={(target_field) => onChange({ ...config, target_field })}
        />
      </FieldGroup>
      {type === 'rollup' && (
        <FieldGroup label={t('tables.computed.aggregate')}>
          <Select
            label={t('tables.computed.aggregate')}
            value={config.aggregate ?? 'count'}
            options={ROLLUP_AGGREGATES.map((value) => ({ value, label: t(`tables.computed.aggregate.${value}`) }))}
            onChange={(aggregate) => onChange({ ...config, aggregate: aggregate as FieldConfig['aggregate'] })}
          />
        </FieldGroup>
      )}
    </>
  );
}
