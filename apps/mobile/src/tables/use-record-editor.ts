import { captureIdentity } from '../data/identity';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useNavigation, useRouter } from 'expo-router';
import { base, record, saveRecord, fillForm, submitForm } from '../api/tables';
import { useResource } from '../data/use-resource';
import { changedValues, mayEdit } from './model';
import { useT } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import type { Base, RecordDetail, FormFill } from '../shared/contract';
export function useRecordEditor(id: string) {
  const t = useT();
  const nav = useNavigation();
  const router = useRouter();
  const load = useCallback(async () => {
    const current = captureIdentity();
    const result = await record(id);
    if (!current()) return { ok: false as const, status: 0, code: 'cancelled', message: '' };
    if (!result.ok) return result;
    const b = await base(result.data.base_id);
    return b.ok ? { ok: true as const, data: { detail: result.data, base: b.data } } : b;
  }, [id]);
  const resource = useResource(load, ['records.changed', 'base.updated']);
  const [snapshot, setSnapshot] = useState<{ detail: RecordDetail; base: Base } | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const draft = useRef(values);
  draft.current = values;
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const busy = useRef(false);
  useEffect(() => nav.addListener('beforeRemove', () => Keyboard.dismiss()), [nav]);
  const current = editing ? snapshot : resource.data;
  const table = current?.base.tables.find((table) => table.id === current.detail.table_id);
  const editable = !!current && !!table && mayEdit(current.base, table);
  const changes = changedValues(snapshot?.detail.record.values ?? {}, values);
  const dirty = editing && Object.keys(changes).length > 0;
  const begin = () => {
    if (!resource.data) return;
    setSnapshot(resource.data);
    setValues({ ...resource.data.detail.record.values });
    setEditing(true);
    setEpoch((n) => n + 1);
  };
  const reload = async () => {
    if (
      dirty &&
      !(await confirmAction({
        title: t('common.discardTitle'),
        message: t('common.discardHint'),
        confirmLabel: t('work.reload'),
        destructive: true,
      }))
    )
      return;
    const result = await resource.refresh();
    if (!result?.ok) {
      alertError(t('work.loadFailed'), result?.message);
      return;
    }
    Keyboard.dismiss();
    setEditing(false);
  };
  const save = async () => {
    if (!snapshot || busy.current) return;
    busy.current = true;
    setSaving(true);
    const current = captureIdentity();
    const result = await saveRecord(id, snapshot.detail.record.revision, changes);
    busy.current = false;
    if (!current()) return;
    setSaving(false);
    if (!result.ok) {
      alertError(t(result.code === 'stale_revision' ? 'work.changed' : 'work.saveFailed'), undefined, result.message);
      return;
    }
    Keyboard.dismiss();
    if (draft.current === values) setEditing(false);
    else {
      setSnapshot({ ...snapshot, detail: { ...snapshot.detail, record: result.data } });
      setValues({ ...result.data.values, ...changedValues(values, draft.current) });
    }
    void resource.refresh();
  };
  return {
    resource,
    current,
    table,
    editable,
    values,
    editing,
    saving,
    dirty,
    epoch,
    begin,
    reload,
    save,
    change: (id: string, value: unknown) => setValues((old) => ({ ...old, [id]: value })),
    close: () => router.back(),
    canSave: dirty && Object.values(changes).every((value) => typeof value !== 'number' || Number.isFinite(value)),
  };
}
export function useFormFill(id: string) {
  const resource = useResource(
    useCallback(() => fillForm(id), [id]),
    ['base.updated'],
  );
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [snapshot, setSnapshot] = useState<FormFill | null>(null);
  const form = snapshot ?? resource.data;
  const busy = useRef(false);
  const t = useT();
  const nav = useNavigation();
  useEffect(() => nav.addListener('beforeRemove', () => Keyboard.dismiss()), [nav]);
  const dirty = Object.keys(values).length > 0 && !submitted;
  const canSave =
    form?.status === 'published' &&
    !submitted &&
    !(form.single_submit && form.submitted) &&
    Object.values(values).every((value) => typeof value !== 'number' || Number.isFinite(value)) &&
    form.fields.every(
      (field) =>
        !field.required ||
        (field.type === 'checkbox'
          ? values[field.id] === true
          : Array.isArray(values[field.id])
            ? (values[field.id] as unknown[]).length > 0
            : values[field.id] !== null && values[field.id] !== undefined && values[field.id] !== ''),
    );
  const save = async () => {
    if (!canSave || busy.current) return;
    busy.current = true;
    setSaving(true);
    const current = captureIdentity();
    const result = await submitForm(id, values);
    busy.current = false;
    if (!current()) return;
    setSaving(false);
    if (!result.ok) {
      alertError(t('work.saveFailed'), undefined, result.message);
      return;
    }
    Keyboard.dismiss();
    setSubmitted(true);
    setValues({});
  };
  return {
    resource,
    form,
    values,
    saving,
    submitted,
    dirty,
    canSave: !!canSave,
    save,
    change: (id: string, value: unknown) => {
      if (!snapshot && resource.data) setSnapshot(resource.data);
      setValues((old) => ({ ...old, [id]: value }));
    },
  };
}
