/**
 * Quick add of a record on Android (Material form); see ./new-record.tsx. Dates are typed as
 * YYYY-MM-DD here.
 */

import React, { useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { selectOptions } from '../../src/data/table-fields';
import { useT } from '../../src/lib/i18n';
import type { TableField } from '../../src/shared/greenhouse-types';
import { useNewRecord } from '../../src/tables/use-new-record';
import { EmptyState } from '../../src/ui/empty';
import {
  FormFields,
  FormLoading,
  FormSection,
  FormSelectRow,
  FormSwitchRow,
  FormTextField,
  NativeForm,
  useNativeState,
} from '../../src/ui/native-form.android';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { objectId } from '../../src/lib/object-id';

function TextRow({
  field,
  kind,
  onChange,
}: {
  field: TableField;
  kind: 'text' | 'number' | 'date';
  onChange: (text: string) => void;
}) {
  const state = useNativeState('');
  return (
    <FormTextField
      label={field.required ? `${field.name} *` : field.name}
      state={state}
      onChangeText={onChange}
      keyboard={kind === 'number' ? 'decimal' : undefined}
      placeholder={kind === 'date' ? 'YYYY-MM-DD' : undefined}
    />
  );
}

export default function NewRecord() {
  const { table } = useLocalSearchParams<{ table?: string }>();
  const tableId = objectId(table);
  const t = useT();
  const router = useRouter();
  const form = useNewRecord(tableId);

  // close once the added record cleared the discard guard (dirty turns off on the next render)
  useEffect(() => {
    if (form.saved) router.back();
  }, [form.saved, router]);

  return (
    <>
      <FormChrome
        title={t('tables.addRecord')}
        dirty={form.dirty}
        canSave={!!form.schema && form.fields.length > 0}
        saving={form.saving}
        onSave={() => void form.submit()}
        protectNavigation
      />
      {form.error && !form.schema ? (
        <EmptyState icon="alert" title={t('tables.loadFailed')} onRetry={form.retry} />
      ) : (
        <NativeForm>
          {!form.schema ? (
            <FormLoading />
          ) : (
            <>
              <FormFields>
                {form.fields
                  .filter((field) => field.type === 'text' || field.type === 'number' || field.type === 'date')
                  .map((field) => (
                    <TextRow
                      key={field.id}
                      field={field}
                      kind={field.type === 'number' ? 'number' : field.type === 'date' ? 'date' : 'text'}
                      onChange={(text) => form.set(field.id, text)}
                    />
                  ))}
              </FormFields>
              <FormSection footer={form.readOnlyCount > 0 ? t('tables.readOnly') : undefined}>
                {form.fields.map((field) => {
                  const key = String(field.id);
                  const value = form.draft[key];
                  if (field.type === 'boolean') {
                    return (
                      <FormSwitchRow
                        key={key}
                        label={field.name}
                        value={value === true}
                        onValueChange={(on) => form.set(field.id, on)}
                      />
                    );
                  }
                  if (field.type === 'single_select') {
                    return (
                      <FormSelectRow
                        key={key}
                        label={field.required ? `${field.name} *` : field.name}
                        value={typeof value === 'string' ? value : ''}
                        options={[
                          { value: '', label: t('tables.noneSelected') },
                          ...selectOptions(field).map((option) => ({ value: option.id, label: option.label })),
                        ]}
                        onChange={(next) => form.set(field.id, next || null)}
                      />
                    );
                  }
                  return null;
                })}
              </FormSection>
            </>
          )}
        </NativeForm>
      )}
    </>
  );
}
