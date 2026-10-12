/**
 * The record sheet (spec 20261011-mobile-tables-apps §2): create or edit a
 * Tables record as a full-height SwiftUI form — one control per field type
 * (src/tables/field-control.tsx), only the fields my role may write editable,
 * the rest read-only, computed fields shown read-only. The shared `FormChrome`:
 * ✓ saves (off while a required field I may write is empty or a number does
 * not parse), ✕ asks before discarding edits. Create sends the non-empty values
 * (a kanban lane / calendar day arrives prefilled via `?k=`); edit sends only
 * what changed, at the revision it was read at — replayed over an automation's
 * concurrent write when it touched other fields, else "changed by someone
 * else". A save bumps the table's records (the page underneath refetches).
 *
 * The Form is mounted from the first frame (a ProgressView row while the record
 * loads); the fields mount once it has. Multi-select, people (beyond the menu)
 * and related rows open the choice sheet (`/tables/pick`); its answer comes
 * back through `usePick`.
 *
 * Params: `tableId`, `baseId?`, `recordId?` (edit), `k?` (handoff: prefilled
 * values, field id → wire value). Android: ./record-form.android.tsx.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { ProgressView, Section, Text } from '@expo/ui/swift-ui';
import { useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { createRecord, getRecord, updateRecordWithReplay, type TableRecord } from '../../src/api/tables';
import { getHandoff } from '../../src/lib/handoff';
import { useT } from '../../src/lib/i18n';
import { FieldForm, invalidNumbers } from '../../src/tables/field-control';
import { useValueLabels } from '../../src/tables/labels';
import { tableAbilities } from '../../src/tables/model/access';
import {
  changedValues,
  controlFor,
  draftValue,
  fieldConfig,
  missingRequired,
  recordValue,
  relationMultiple,
  type FieldLike,
} from '../../src/tables/model/fields';
import { pickHref, usePick, type PickRequest } from '../../src/tables/pick';
import { TablesRouteGate } from '../../src/tables/route-gate';
import { useSchema, useTableUsers, useTables, useWorkspace } from '../../src/tables/store';
import { alertError } from '../../src/ui/dialogs';
import { NativeForm } from '../../src/ui/native-form';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

export default function RecordFormScreen() {
  return (
    <TablesRouteGate area="tables" latched>
      <RecordForm />
    </TablesRouteGate>
  );
}

let formSeq = 0;

function RecordForm() {
  const t = useT();
  const router = useRouter();
  const navigation = useNavigation();
  const params = useLocalSearchParams<{ tableId: string; baseId?: string; recordId?: string; k?: string }>();
  const tableId = Number(params.tableId);
  const recordId = Number(params.recordId) || null;
  const { schema } = useSchema(tableId);
  const baseId = Number(params.baseId) || schema?.table.base_id || 0;
  const { workspace } = useWorkspace(baseId);
  const users = useTableUsers();
  const labels = useValueLabels({ users });
  const recordsChanged = useTables((s) => s.recordsChanged);
  const instance = useRef(`record-form-${++formSeq}`).current;

  const fields = useMemo(
    () => [...(schema?.fields ?? [])].filter((field) => !field.archived_at).sort((a, b) => a.position - b.position),
    [schema],
  );
  const abilities = useMemo(() => tableAbilities(workspace, tableId, fields), [workspace, tableId, fields]);

  // the record being edited (create: none)
  const [record, setRecord] = useState<TableRecord | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!recordId) return;
    let live = true;
    void getRecord(tableId, recordId).then((result) => {
      if (!live) return;
      if (result.ok) setRecord(result.value);
      else setGone(true);
    });
    return () => {
      live = false;
    };
  }, [tableId, recordId]);

  const ready = !!schema && !!workspace && (!recordId || !!record);
  const [initial, setInitial] = useState<Record<string, unknown> | null>(null);
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [picked, setPicked] = useState<Record<string, Record<string, string>>>({});
  const [openDate, setOpenDate] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  // the starting values: the record's, or the prefilled ones for a new record
  useEffect(() => {
    if (!ready || initial) return;
    const defaults = recordId ? {} : (getHandoff<Record<string, unknown>>(params.k) ?? {});
    const start: Record<string, unknown> = {};
    for (const field of fields) {
      const stored = record ? recordValue(record, field.id) : defaults[String(field.id)];
      start[String(field.id)] = draftValue(field, stored);
    }
    setInitial(start);
    setDraft(start);
  }, [ready, initial, recordId, params.k, fields, record]);

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

  // never delete a focused field's section (UIKit crashes): drop the keyboard as the sheet goes
  useEffect(() => navigation.addListener('beforeRemove', () => Keyboard.dismiss()), [navigation]);

  const onPick = useCallback(
    (field: FieldLike) => {
      const value = draft[String(field.id)];
      const selected = Array.isArray(value) ? value : value == null || value === '' ? [] : [value];
      const multiple =
        field.type === 'multi_select' ||
        field.type === 'multi_user' ||
        (field.type === 'relation' && relationMultiple(field));
      const request: PickRequest = {
        id: `${instance}:${field.id}`,
        area: 'tables',
        title: field.name,
        multiple,
        selected: selected as Array<string | number>,
        labels: picked[String(field.id)],
        source:
          field.type === 'relation'
            ? { kind: 'records', tableId: fieldConfig(field).relation?.targetTableId ?? 0 }
            : field.type === 'multi_select'
              ? {
                  kind: 'options',
                  choices: (fieldConfig(field).options ?? []).map((option) => ({
                    value: option.id,
                    label: option.label,
                  })),
                }
              : {
                  kind: 'options',
                  choices: users.map((user) => ({
                    value: user.id,
                    label: user.nickname || user.email,
                    detail: user.email,
                  })),
                },
      };
      router.push(pickHref(request));
    },
    [draft, picked, instance, users, router],
  );

  const create = !recordId;
  const editable = abilities.editable;
  const dirty = !!initial && JSON.stringify(initial) !== JSON.stringify(draft);
  const missing = initial ? missingRequired(fields, editable, draft) : [];
  const badNumbers = initial
    ? invalidNumbers(
        fields.filter((field) => editable.has(field.id)),
        draft,
      )
    : [];
  const canSave = !!initial && (create ? true : dirty) && missing.length === 0 && badNumbers.length === 0;

  const save = useCallback(async () => {
    if (!initial || saving) return;
    const values = changedValues(fields, editable, initial, draft, { create });
    setSaving(true);
    const result = create
      ? await createRecord(tableId, values)
      : await updateRecordWithReplay(tableId, record!, values);
    setSaving(false);
    if (!result.ok) {
      if (result.status === 409) alertError(t('tables.form.conflict'), t('tables.form.conflictHint'));
      else alertError(t('tables.form.saveFailed'), result.message || undefined);
      return;
    }
    recordsChanged(tableId);
    toast(create ? t('tables.form.created') : t('tables.form.saved'), 'checkCircle');
    Keyboard.dismiss();
    router.back();
  }, [initial, saving, fields, editable, draft, create, tableId, record, recordsChanged, router, t]);

  const shown = fields.filter((field) => (create ? controlFor(field) !== 'readonly' || field.required : true));

  return (
    <>
      <FormChrome
        title={create ? t('tables.form.newTitle') : t('tables.form.editTitle')}
        dirty={dirty}
        canSave={canSave}
        saving={saving}
        onSave={() => void save()}
      />
      <NativeForm>
        {gone ? (
          <Section>
            <Text>{t('tables.recordMissing')}</Text>
          </Section>
        ) : !initial ? (
          <Section>
            <ProgressView />
          </Section>
        ) : (
          <>
            {editable.size === 0 ? (
              <Section>
                <Text>{t('tables.form.noEditable')}</Text>
              </Section>
            ) : null}
            <FieldForm
              fields={shown}
              draft={draft}
              onChange={(fieldId, value) => setDraft((prev) => ({ ...prev, [String(fieldId)]: value }))}
              editable={editable}
              labels={labels}
              users={users}
              onPick={onPick}
              picked={picked}
              openDate={openDate}
              setOpenDate={setOpenDate}
            />
            {dirty && missing.length ? (
              <Section>
                <Text>
                  {t('tables.form.missingRequired', { fields: missing.map((field) => field.name).join(', ') })}
                </Text>
              </Section>
            ) : null}
            {badNumbers.length ? (
              <Section>
                <Text>
                  {t('tables.form.invalidNumbers', { fields: badNumbers.map((field) => field.name).join(', ') })}
                </Text>
              </Section>
            ) : null}
          </>
        )}
      </NativeForm>
    </>
  );
}
