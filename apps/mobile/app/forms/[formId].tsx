/**
 * A submit-only form (`/api/forms`, foundation spec §3; not behind the Tables
 * switch — a form's audience need not use Tables, D5): the title and
 * description, one control per field (src/tables/field-control.tsx), photos for
 * attachment fields (camera or library, uploaded as they are picked to the
 * form's staging area and bound on submit), and Submit. After a submit: the
 * form's own thank-you line, and "Submit another" when it takes several. A
 * single-submission form I already answered says so. Related-row fields take
 * record ids, like the web's form page (the submit view does not name the
 * target table).
 *
 * The SwiftUI Form is mounted from the first frame (a ProgressView row while
 * the form loads). Params: `formId`. Android: ./[formId].android.tsx.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { Button, ProgressView, Section, Text } from '@expo/ui/swift-ui';
import { disabled, foregroundStyle } from '@expo/ui/swift-ui/modifiers';
import { Stack, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { openForm, submitForm, uploadFormFile } from '../../src/api/tables';
import type { TableFormSubmitView } from '../../src/shared/tables';
import type { TableUser } from '../../src/shared/tables-wire';
import { useT } from '../../src/lib/i18n';
import { FieldForm, invalidNumbers, type AttachmentDraft } from '../../src/tables/field-control';
import { useValueLabels } from '../../src/tables/labels';
import { changedValues, draftValue, missingRequired, type FieldLike } from '../../src/tables/model/fields';
import { pickPhoto } from '../../src/tables/photos';
import { pickHref, usePick } from '../../src/tables/pick';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { NativeForm } from '../../src/ui/native-form';

export default function FormScreen() {
  return (
    <TablesRouteGate area="internal" latched>
      <SubmitForm />
    </TablesRouteGate>
  );
}

let formSeq = 0;

/** The form's fields as the shared controls see them (a related-row field takes ids as text). */
function formFields(form: TableFormSubmitView): FieldLike[] {
  return form.fields.map((field) => ({
    id: field.id,
    name: field.name,
    type: field.type === 'relation' ? 'text' : field.type,
    required: field.required,
    config: { options: field.options ?? [] },
  }));
}

/** "12, 14" → the relation value (one id, or several). */
function relationValue(text: unknown, multiple: boolean): number | number[] | null {
  const ids = String(text ?? '')
    .split(/[,\s，]+/)
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return null;
  return multiple ? ids : ids[0]!;
}

function SubmitForm() {
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const { hex } = useTheme();
  const params = useLocalSearchParams<{ formId: string }>();
  const formId = Number(params.formId);
  const instance = useRef(`form-${++formSeq}`).current;
  const [form, setForm] = useState<TableFormSubmitView | null>(null);
  const [missingForm, setMissingForm] = useState(false);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [initial, setInitial] = useState<Record<string, unknown>>({});
  const [files, setFiles] = useState<Record<string, AttachmentDraft[]>>({});
  const [uploading, setUploading] = useState<number | null>(null);
  const [openDate, setOpenDate] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(async () => {
    const result = await openForm(formId);
    if (!result.ok) return setMissingForm(true);
    setForm(result.value);
    setMissingForm(false);
    const fields = formFields(result.value);
    const start = Object.fromEntries(fields.map((field) => [String(field.id), draftValue(field, null)]));
    setInitial(start);
    setDraft(start);
    setFiles({});
  }, [formId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => navigation.addListener('beforeRemove', () => Keyboard.dismiss()), [navigation]);

  const fields = useMemo(() => (form ? formFields(form) : []), [form]);
  const editable = useMemo(() => new Set(fields.map((field) => field.id)), [fields]);
  const users = useMemo<TableUser[]>(
    () =>
      (form?.userOptions ?? []).map((user) => ({
        id: user.id,
        nickname: user.name,
        email: user.email ?? '',
        role: 'team',
      })),
    [form],
  );
  const labels = useValueLabels({ users });

  // the choice sheet's answers (multi-select, several people)
  const results = usePick((s) => s.results);
  const forget = usePick((s) => s.forget);
  useEffect(() => {
    for (const field of fields) {
      const id = `${instance}:${field.id}`;
      const answer = results[id];
      if (!answer) continue;
      forget(id);
      setDraft((prev) => ({ ...prev, [String(field.id)]: answer.values }));
    }
  }, [results, fields, instance, forget]);

  const onPick = useCallback(
    (field: FieldLike) => {
      const value = draft[String(field.id)];
      router.push(
        pickHref({
          id: `${instance}:${field.id}`,
          area: 'internal',
          title: field.name,
          multiple: field.type === 'multi_select' || field.type === 'multi_user',
          selected: Array.isArray(value) ? (value as string[]) : value ? [value as string] : [],
          source: {
            kind: 'options',
            choices:
              field.type === 'multi_select'
                ? ((field.config as { options: Array<{ id: string; label: string }> }).options ?? []).map((option) => ({
                    value: option.id,
                    label: option.label,
                  }))
                : users.map((user) => ({ value: user.id, label: user.nickname, detail: user.email || undefined })),
          },
        }),
      );
    },
    [draft, instance, router, users],
  );

  const addPhoto = useCallback(
    async (field: FieldLike, from: 'camera' | 'library') => {
      const photo = await pickPhoto(from);
      if (!photo) return;
      setUploading(field.id);
      const result = await uploadFormFile(formId, photo);
      setUploading(null);
      if (!result.ok) return alertError(t('tables.forms.uploadFailed'), result.message || undefined);
      const key = String(field.id);
      setFiles((prev) => ({
        ...prev,
        [key]: [...(prev[key] ?? []), { id: result.value.id, name: result.value.name }],
      }));
      setDraft((prev) => ({ ...prev, [key]: [...((prev[key] as number[]) ?? []), result.value.id] }));
    },
    [formId, t],
  );
  const removePhoto = useCallback((field: FieldLike, fileId: number) => {
    const key = String(field.id);
    setFiles((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((file) => file.id !== fileId) }));
    setDraft((prev) => ({ ...prev, [key]: ((prev[key] as number[]) ?? []).filter((id) => id !== fileId) }));
  }, []);

  const missing = form ? missingRequired(fields, editable, draft) : [];
  const dirty = JSON.stringify(initial) !== JSON.stringify(draft);
  const badNumbers = form ? invalidNumbers(fields, draft) : [];
  const canSubmit =
    !!form && !done && !form.alreadySubmitted && !missing.length && !badNumbers.length && uploading === null;

  const submit = useCallback(async () => {
    if (!form || !canSubmit || saving) return;
    const values = changedValues(fields, editable, {}, draft, { create: true });
    for (const field of form.fields) {
      if (field.type !== 'relation') continue;
      const value = relationValue(draft[String(field.id)], field.multiple === true);
      if (value === null) delete values[String(field.id)];
      else values[String(field.id)] = value;
    }
    setSaving(true);
    const result = await submitForm(formId, values);
    setSaving(false);
    if (!result.ok) {
      return alertError(t('tables.forms.submitFailed'), result.message || undefined);
    }
    Keyboard.dismiss();
    setDone(result.value.successMessage || t('tables.forms.submittedHint'));
  }, [form, canSubmit, saving, fields, editable, draft, formId, t]);

  return (
    <>
      <Stack.Screen options={{ title: form?.title || form?.name || t('tables.forms.title') }} />
      <NativeForm>
        {missingForm ? (
          <Section footer={<Text>{t('tables.forms.missingHint')}</Text>}>
            <Text>{t('tables.forms.missing')}</Text>
          </Section>
        ) : !form ? (
          <Section>
            <ProgressView />
          </Section>
        ) : done ? (
          <Section footer={<Text>{done}</Text>}>
            <Text>{t('tables.forms.submitted')}</Text>
            {form.allowMultiple ? (
              <Button
                label={t('tables.forms.submitAnother')}
                systemImage="arrow.clockwise"
                onPress={() => {
                  setDone(null);
                  void load();
                }}
              />
            ) : null}
          </Section>
        ) : form.alreadySubmitted ? (
          <Section>
            <Text>{t('tables.forms.alreadySubmitted')}</Text>
          </Section>
        ) : (
          <>
            {form.description ? (
              <Section>
                <Text modifiers={[foregroundStyle(hex.secondaryLabel)]}>{form.description}</Text>
              </Section>
            ) : null}
            <FieldForm
              fields={fields}
              draft={draft}
              onChange={(fieldId, value) => setDraft((prev) => ({ ...prev, [String(fieldId)]: value }))}
              editable={editable}
              labels={labels}
              users={users}
              onPick={onPick}
              openDate={openDate}
              setOpenDate={setOpenDate}
              attachments={{
                files,
                uploading,
                onAdd: (field, from) => void addPhoto(field, from),
                onRemove: removePhoto,
              }}
            />
            <Section
              footer={
                badNumbers.length ? (
                  <Text>
                    {t('tables.form.invalidNumbers', { fields: badNumbers.map((field) => field.name).join(', ') })}
                  </Text>
                ) : dirty && missing.length ? (
                  <Text>
                    {t('tables.form.missingRequired', { fields: missing.map((field) => field.name).join(', ') })}
                  </Text>
                ) : undefined
              }
            >
              <Button
                label={form.submitLabel || t('tables.forms.submit')}
                systemImage="paperplane"
                onPress={() => void submit()}
                modifiers={[disabled(!canSubmit || saving)]}
              />
            </Section>
          </>
        )}
      </NativeForm>
    </>
  );
}
