/**
 * An app's write sheet (spec §3) — one SwiftUI form for every write an app
 * page makes with fields, all through the gateway's `/actions`:
 *
 *  - `submit` — a form card (`$submit`; the spec's hidden defaults are applied
 *    by the server, never sent from here);
 *  - `create` — a records card's "+" (`$create`);
 *  - `button` — a `create_record` button (`$create` + `buttonId`);
 *  - `action` — a declared action's input fields ("reject" asks for a reason),
 *    run with them in the same write, at the record's revision;
 *  - `edit`   — the record's editable fields (`$edit`), only what changed.
 *
 * Fields come from the runtime view (my role's readable fields of that table);
 * people and related rows open the choice sheet fed by the gateway's
 * `/options`; attachment fields take photos (camera / library), uploaded as
 * they are picked (`/uploads`) and bound by the write. ✓ sends, ✕ asks before
 * discarding. A refusal says why (src/apps/actions.ts).
 *
 * Params: `appId`, `pageId`, `cardId`, `mode`, `actionId?`, `buttonId?`,
 * `recordId?` + `revision?`. Android: ./form.android.tsx.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { ProgressView, Section, Text } from '@expo/ui/swift-ui';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { getAppRecord, newRequestId, runAction, uploadAppFile } from '../../src/api/apps';
import { findCard, type AppButton, type AppRecordRow } from '../../src/shared/apps';
import { useT } from '../../src/lib/i18n';
import { reportDone, reportRefusal } from '../../src/apps/actions';
import { tableFields, writeTarget, type AppWriteMode } from '../../src/apps/model';
import { useApps } from '../../src/apps/store';
import { FieldForm, invalidNumbers, type AttachmentDraft } from '../../src/tables/field-control';
import { useValueLabels } from '../../src/tables/labels';
import {
  changedValues,
  controlFor,
  draftValue,
  missingRequired,
  recordValue,
  relationMultiple,
  type FieldLike,
} from '../../src/tables/model/fields';
import { pickPhoto } from '../../src/tables/photos';
import { pickHref, usePick } from '../../src/tables/pick';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { alertError } from '../../src/ui/dialogs';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

export default function AppFormScreen() {
  return (
    <TablesRouteGate area="apps" latched>
      <AppForm />
    </TablesRouteGate>
  );
}

let formSeq = 0;
const MODES: readonly AppWriteMode[] = ['submit', 'create', 'button', 'action', 'edit'];

function AppForm() {
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{
    appId: string;
    pageId: string;
    cardId: string;
    mode: string;
    actionId?: string;
    buttonId?: string;
    recordId?: string;
    revision?: string;
  }>();
  const appId = Number(params.appId);
  const mode = (MODES as readonly string[]).includes(params.mode) ? (params.mode as AppWriteMode) : 'submit';
  const recordId = Number(params.recordId) || undefined;
  const instance = useRef(`app-form-${++formSeq}`).current;
  const view = useApps((s) => s.views[appId]);
  const loadApp = useApps((s) => s.loadApp);
  const written = useApps((s) => s.written);

  useEffect(() => {
    if (!view) void loadApp(appId);
  }, [view, appId, loadApp]);

  const card = view ? findCard(view.spec, params.pageId, params.cardId) : undefined;
  const target = card ? writeTarget(card, mode, { actionId: params.actionId, buttonId: params.buttonId }) : null;

  // edit: the record as my role reads it through this card, and what I may change
  const [editing, setEditing] = useState<{ record: AppRecordRow; editable: number[] } | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (mode !== 'edit' || !recordId) return;
    let live = true;
    void getAppRecord(appId, { pageId: params.pageId, cardId: params.cardId, recordId }).then((result) => {
      if (!live) return;
      if (result.ok) setEditing({ record: result.value.record, editable: result.value.editableFieldIds });
      else setGone(true);
    });
    return () => {
      live = false;
    };
  }, [mode, recordId, appId, params.pageId, params.cardId]);

  const fields = useMemo<FieldLike[]>(() => {
    if (!view || !target) return [];
    const byId = new Map((tableFields(view, target.tableId) as FieldLike[]).map((field) => [field.id, field]));
    const ids = mode === 'edit' ? (editing?.editable ?? []) : target.fieldIds;
    const required = new Set(target.required);
    return ids
      .map((id) => byId.get(id))
      .filter((field): field is FieldLike => !!field && controlFor(field) !== 'readonly')
      .map((field) => (required.has(field.id) ? { ...field, required: true } : field));
  }, [view, target, mode, editing]);
  const editable = useMemo(() => new Set(fields.map((field) => field.id)), [fields]);

  const ready = !!view && !!target && (mode !== 'edit' || !!editing);
  const [initial, setInitial] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [picked, setPicked] = useState<Record<string, Record<string, string>>>({});
  const [files, setFiles] = useState<Record<string, AttachmentDraft[]>>({});
  const [uploading, setUploading] = useState<number | null>(null);
  const [openDate, setOpenDate] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const labels = useValueLabels({ refs: null });

  useEffect(() => {
    if (!ready || initial) return;
    const start: Record<string, unknown> = {};
    for (const field of fields) {
      start[String(field.id)] = draftValue(field, editing ? recordValue(editing.record, field.id) : null);
    }
    setInitial(start);
    setDraft(start);
  }, [ready, initial, fields, editing]);

  // the choice sheet's answers
  const results = usePick((s) => s.results);
  const forget = usePick((s) => s.forget);
  useEffect(() => {
    for (const field of fields) {
      const id = `${instance}:${field.id}`;
      const answer = results[id];
      if (!answer) continue;
      forget(id);
      setDraft((prev) => ({ ...prev, [String(field.id)]: answer.values }));
      setPicked((prev) => ({ ...prev, [String(field.id)]: { ...(prev[String(field.id)] ?? {}), ...answer.labels } }));
    }
  }, [results, fields, instance, forget]);
  useEffect(() => navigation.addListener('beforeRemove', () => Keyboard.dismiss()), [navigation]);

  const onPick = useCallback(
    (field: FieldLike) => {
      const value = draft[String(field.id)];
      const selected = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
      const multiple =
        field.type === 'multi_select' ||
        field.type === 'multi_user' ||
        (field.type === 'relation' && relationMultiple(field));
      router.push(
        pickHref({
          id: `${instance}:${field.id}`,
          area: 'apps',
          title: field.name,
          multiple,
          selected: selected as Array<string | number>,
          labels: picked[String(field.id)],
          source:
            field.type === 'multi_select'
              ? {
                  kind: 'options',
                  choices: ((field.config as { options?: Array<{ id: string; label: string }> })?.options ?? []).map(
                    (option) => ({ value: option.id, label: option.label }),
                  ),
                }
              : {
                  kind: 'app',
                  appId,
                  pageId: params.pageId,
                  cardId: params.cardId,
                  fieldId: field.id,
                  ...(params.buttonId ? { buttonId: params.buttonId } : {}),
                },
        }),
      );
    },
    [draft, picked, instance, router, appId, params.pageId, params.cardId, params.buttonId],
  );

  const addPhoto = useCallback(
    async (field: FieldLike, from: 'camera' | 'library') => {
      const photo = await pickPhoto(from);
      if (!photo) return;
      setUploading(field.id);
      const result = await uploadAppFile(
        appId,
        { pageId: params.pageId, cardId: params.cardId, fieldId: field.id },
        photo,
      );
      setUploading(null);
      if (!result.ok) return alertError(t('tables.forms.uploadFailed'), result.message || undefined);
      const key = String(field.id);
      setFiles((prev) => ({
        ...prev,
        [key]: [...(prev[key] ?? []), { id: result.value.id, name: result.value.name }],
      }));
      setDraft((prev) => ({ ...prev, [key]: [...((prev[key] as number[]) ?? []), result.value.id] }));
    },
    [appId, params.pageId, params.cardId, t],
  );
  const removePhoto = useCallback((field: FieldLike, fileId: number) => {
    const key = String(field.id);
    setFiles((prev) => ({ ...prev, [key]: (prev[key] ?? []).filter((file) => file.id !== fileId) }));
    setDraft((prev) => ({ ...prev, [key]: ((prev[key] as number[]) ?? []).filter((id) => id !== fileId) }));
  }, []);

  const dirty = !!initial && JSON.stringify(initial) !== JSON.stringify(draft);
  const missing = initial ? missingRequired(fields, editable, draft) : [];
  const badNumbers = initial ? invalidNumbers(fields, draft) : [];
  const canSave =
    !!initial && (mode === 'edit' ? dirty : true) && !missing.length && !badNumbers.length && uploading === null;

  const action =
    card && mode === 'action' && 'actions' in card
      ? [...(card.actions ?? []), ...(('detail' in card && card.detail?.actions) || [])].find(
          (entry) => entry.id === params.actionId,
        )
      : undefined;
  const button =
    card?.kind === 'buttons'
      ? card.buttons.find(
          (entry): entry is Extract<AppButton, { type: 'create_record' }> => entry.id === params.buttonId,
        )
      : undefined;
  const title =
    mode === 'submit'
      ? card?.title || t('apps.form.submitTitle')
      : mode === 'create'
        ? card?.title
          ? `${t('apps.form.createTitle')} · ${card.title}`
          : t('apps.form.createTitle')
        : mode === 'button'
          ? (button?.label ?? t('apps.form.createTitle'))
          : mode === 'action'
            ? t('apps.form.actionTitle', { label: action?.label ?? '' })
            : t('apps.form.editTitle');
  const save = useCallback(async () => {
    if (!initial || !target || saving) return;
    const values = changedValues(fields, editable, initial, draft, { create: mode !== 'edit' });
    setSaving(true);
    const revision = editing?.record.revision ?? (Number(params.revision) || undefined);
    const result = await runAction(appId, {
      pageId: params.pageId,
      cardId: params.cardId,
      actionId: target.actionId,
      ...(recordId ? { recordId } : {}),
      ...(revision ? { revision } : {}),
      ...(params.buttonId ? { buttonId: params.buttonId } : {}),
      values: Object.entries(values).map(([fieldId, value]) => ({ fieldId: Number(fieldId), value })),
      requestId: newRequestId(),
    });
    setSaving(false);
    if (!result.ok) return reportRefusal(result, title);
    written(appId);
    Keyboard.dismiss();
    if (mode === 'submit' && card?.kind === 'form') toast(card.successMessage || t('apps.submitted'), 'checkCircle');
    else reportDone(result.value);
    router.back();
  }, [
    initial,
    target,
    saving,
    fields,
    editable,
    draft,
    mode,
    editing,
    params,
    appId,
    recordId,
    written,
    card,
    router,
    t,
    title,
  ]);

  const unavailable = !!view && (!card || !target);

  return (
    <>
      <FormChrome
        title={title}
        dirty={dirty}
        canSave={canSave}
        saving={saving}
        onSave={() => void save()}
        saveLabel={mode === 'submit' && card?.kind === 'form' ? card.submitLabel || t('apps.form.send') : undefined}
      />
      <NativeForm>
        {unavailable || gone ? (
          <Section>
            <Text>{t('apps.form.gone')}</Text>
          </Section>
        ) : !initial ? (
          <Section>
            <ProgressView />
          </Section>
        ) : (
          <>
            <FieldForm
              fields={fields}
              draft={draft}
              onChange={(fieldId, value) => setDraft((prev) => ({ ...prev, [String(fieldId)]: value }))}
              editable={editable}
              labels={labels}
              onPick={onPick}
              picked={picked}
              openDate={openDate}
              setOpenDate={setOpenDate}
              attachments={{
                files,
                uploading,
                onAdd: (field, from) => void addPhoto(field, from),
                onRemove: removePhoto,
              }}
            />
            {missing.length ? (
              <Section>
                <Text>
                  {t('tables.form.missingRequired', { fields: missing.map((field) => field.name).join(', ') })}
                </Text>
              </Section>
            ) : null}
          </>
        )}
      </NativeForm>
    </>
  );
}
