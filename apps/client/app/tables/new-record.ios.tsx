/**
 * Quick add of a record (`/tables/new-record?table=`), a sheet with a SwiftUI form: only the
 * simple field types are written from the phone (text, number, date, single select, checkbox);
 * the rest are edited on the web. Behaviour in src/tables/use-new-record.ts; Android:
 * ./new-record.android.tsx.
 */

import React, { useEffect } from 'react';
import { Picker, Section, Text, TextField, Toggle, DatePicker, useNativeState } from '@expo/ui/swift-ui';
import { keyboardType, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { localDay } from '../../src/data/tasks';
import { selectOptions } from '../../src/data/table-fields';
import { useT } from '../../src/lib/i18n';
import type { TableField } from '../../src/shared/greenhouse-types';
import { useNewRecord } from '../../src/tables/use-new-record';
import { EmptyState } from '../../src/ui/empty';
import { FormLoading, NativeForm } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { objectId } from '../../src/lib/object-id';
import { useLateField, useLateFields, type LateFields } from '../../src/ui/late-fields';

function TextRow({
  field,
  numeric,
  onChange,
  late,
}: {
  field: TableField;
  numeric?: boolean;
  onChange: (text: string) => void;
  late: LateFields;
}) {
  const state = useNativeState('');
  useLateField(late, String(field.id), state);
  return (
    <TextField
      text={state}
      placeholder={field.required ? `${field.name} *` : field.name}
      onTextChange={onChange}
      modifiers={numeric ? [keyboardType('decimal-pad')] : []}
    />
  );
}

function dayOf(date: Date): string {
  return localDay(date);
}

function parseDay(day: string | undefined): Date {
  const [y, m, d] = (day ?? '').split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : new Date();
}

export default function NewRecord() {
  const { table } = useLocalSearchParams<{ table?: string }>();
  const tableId = objectId(table);
  const t = useT();
  const router = useRouter();
  const form = useNewRecord(tableId);
  const late = useLateFields();

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
        onSave={() => void form.submit(late.read())}
        protectNavigation
      />
      {form.error && !form.schema ? (
        <EmptyState icon="alert" title={t('tables.loadFailed')} onRetry={form.retry} />
      ) : (
        <NativeForm>
          {!form.schema ? (
            <FormLoading />
          ) : (
            <Section footer={form.readOnlyCount > 0 ? <Text>{t('tables.readOnly')}</Text> : undefined}>
              {form.fields.map((field) => {
                const key = String(field.id);
                const value = form.draft[key];
                switch (field.type) {
                  case 'boolean':
                    return (
                      <Toggle
                        key={key}
                        label={field.name}
                        isOn={value === true}
                        onIsOnChange={(on) => form.set(field.id, on)}
                      />
                    );
                  case 'single_select':
                    return (
                      <Picker
                        key={key}
                        label={field.required ? `${field.name} *` : field.name}
                        selection={typeof value === 'string' ? value : ''}
                        onSelectionChange={(next) => form.set(field.id, next ? String(next) : null)}
                        modifiers={[pickerStyle('menu')]}
                      >
                        <Text modifiers={[tag('')]}>{t('tables.noneSelected')}</Text>
                        {selectOptions(field).map((option) => (
                          <Text key={option.id} modifiers={[tag(option.id)]}>
                            {option.label}
                          </Text>
                        ))}
                      </Picker>
                    );
                  case 'date':
                    return typeof value === 'string' && value ? (
                      <React.Fragment key={key}>
                        <Toggle label={field.name} isOn onIsOnChange={(on) => form.set(field.id, on ? value : null)} />
                        <DatePicker
                          title={field.name}
                          selection={parseDay(value)}
                          displayedComponents={['date']}
                          onDateChange={(date) => form.set(field.id, dayOf(date))}
                        />
                      </React.Fragment>
                    ) : (
                      <Toggle
                        key={key}
                        label={field.required ? `${field.name} *` : field.name}
                        isOn={false}
                        onIsOnChange={(on) => form.set(field.id, on ? dayOf(new Date()) : null)}
                      />
                    );
                  case 'number':
                    return <TextRow late={late} key={key} field={field} numeric onChange={(text) => form.set(field.id, text)} />;
                  default:
                    return <TextRow late={late} key={key} field={field} onChange={(text) => form.set(field.id, text)} />;
                }
              })}
            </Section>
          )}
        </NativeForm>
      )}
    </>
  );
}
