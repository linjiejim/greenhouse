import React, { useEffect, useState } from 'react';
import {
  TABLE_AI_FIELD_LIMITS,
  TABLE_AI_MIN_MONTHLY_TOKEN_CAP,
  TABLE_AI_RESULT_TYPES,
  isTableAiInputFieldType,
  type TableAiFieldConfig,
  type TableAiFieldStatusView,
} from '@greenhouse/types/tables';
import { Button, Checkbox, Input, Select, Textarea } from '../../components/ui';
import { FormField } from '../../components/form';
import { FIELD_TYPE_LABEL_KEYS } from '../../components/tables/field-types';
import { getAiFieldStatus, runAiField, type TableField } from '../../lib/api/tables';
import { useT } from '../../lib/i18n';

export const emptyAiConfig = (): TableAiFieldConfig => ({
  prompt: '',
  inputFieldIds: [],
  resultType: 'text',
  autoUpdate: true,
  monthlyTokenCap: TABLE_AI_FIELD_LIMITS.defaultMonthlyTokenCap,
});

export function AiFieldEditor({
  value,
  onChange,
  fields,
}: {
  value: TableAiFieldConfig;
  onChange: (value: TableAiFieldConfig) => void;
  fields: TableField[];
}) {
  const t = useT();
  return (
    <div className="space-y-3">
      <FormField label={t('tables.ai.prompt')} help={t('tables.ai.promptHint')}>
        <Textarea
          value={value.prompt}
          maxLength={TABLE_AI_FIELD_LIMITS.prompt}
          onChange={(event) => onChange({ ...value, prompt: event.target.value })}
        />
      </FormField>
      <FormField label={t('tables.ai.inputs')}>
        <div className="space-y-2">
          {fields
            .filter((field) => isTableAiInputFieldType(field.type))
            .map((field) => (
              <Checkbox
                key={field.id}
                label={`${field.name} (#${field.id})`}
                checked={value.inputFieldIds.includes(field.id)}
                onChange={(event) =>
                  onChange({
                    ...value,
                    inputFieldIds: event.target.checked
                      ? [...value.inputFieldIds, field.id]
                      : value.inputFieldIds.filter((id) => id !== field.id),
                  })
                }
              />
            ))}
        </div>
      </FormField>
      <FormField label={t('tables.ai.resultType')}>
        <Select
          value={value.resultType}
          onChange={(event) =>
            onChange({ ...value, resultType: event.target.value as TableAiFieldConfig['resultType'] })
          }
        >
          {TABLE_AI_RESULT_TYPES.map((type) => (
            <option key={type} value={type}>
              {t(FIELD_TYPE_LABEL_KEYS[type])}
            </option>
          ))}
        </Select>
      </FormField>
      <Checkbox
        label={t('tables.ai.autoUpdate')}
        checked={value.autoUpdate}
        onChange={(event) => onChange({ ...value, autoUpdate: event.target.checked })}
      />
      <FormField label={t('tables.ai.cap')} help={t('tables.ai.payerHint')}>
        <Input
          type="number"
          min={TABLE_AI_MIN_MONTHLY_TOKEN_CAP}
          max={TABLE_AI_FIELD_LIMITS.maxMonthlyTokenCap}
          value={value.monthlyTokenCap ?? TABLE_AI_FIELD_LIMITS.defaultMonthlyTokenCap}
          onChange={(event) => onChange({ ...value, monthlyTokenCap: Number(event.target.value) })}
        />
      </FormField>
    </div>
  );
}

export function AiFieldRuns({ fieldId }: { fieldId: number }) {
  const t = useT();
  const [status, setStatus] = useState<TableAiFieldStatusView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => {
    let canceled = false;
    const load = () =>
      getAiFieldStatus(fieldId)
        .then((next) => {
          if (!canceled) setStatus(next);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(() => {
      void load();
    }, 3000);
    return () => {
      canceled = true;
      clearInterval(timer);
    };
  }, [fieldId]);
  const run = async (mode: 'fill' | 'regenerate') => {
    setBusy(true);
    setError('');
    try {
      const result = await runAiField(fieldId, mode);
      setMessage(t('tables.ai.queuedCount', { count: result.queued, skipped: result.skipped }));
      setStatus(await getAiFieldStatus(fieldId));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('tables.ai.failed'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-2 border-t border-edge pt-3">
      <p className="text-xs text-fg-muted">{t('tables.ai.runSaved')}</p>
      {status && (
        <p className="text-xs text-fg-muted">
          {t('tables.ai.usage', {
            tokens: status.usage.tokens,
            cap: status.usage.cap,
            queued: status.counts.queued,
            running: status.counts.running,
            failed: status.counts.failed,
          })}
        </p>
      )}
      <div className="flex gap-2">
        <Button variant="secondary" disabled={busy} onClick={() => void run('fill')}>
          {t('tables.ai.fill')}
        </Button>
        <Button variant="secondary" disabled={busy} onClick={() => void run('regenerate')}>
          {t('tables.ai.regenerate')}
        </Button>
      </div>
      {message && (
        <p role="status" className="text-xs text-fg-muted">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger-fg">
          {error}
        </p>
      )}
    </div>
  );
}
