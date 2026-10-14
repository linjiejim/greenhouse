import { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard } from 'react-native';
import { useNavigation } from 'expo-router';
import { appRuntime, appRecord, appExecute } from '../api/apps';
import { useResource } from '../data/use-resource';
import { getHandoff } from '../lib/handoff';
import { useT } from '../lib/i18n';
import { alertError, confirmAction } from '../ui/dialogs';
import { cardFields, canAct, validValues, type AppCardContext } from './model';
import { computed } from '../tables/model';
import type { RecordDetail } from '../shared/contract';
import { useAppChoices } from './use-choices';

export function useAppCard(key: string) {
  const t = useT();
  const nav = useNavigation();
  const [context, setContext] = useState(() => getHandoff<AppCardContext>(key, 'app-card'));
  const choices = useAppChoices(context);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [epoch, setEpoch] = useState(0);
  const pending = useRef(false);
  const r = useResource(
    useCallback(async () => {
      if (!context) return { ok: false as const, status: 404, code: 'not_found', message: '' };
      const { runtime, card, record } = context;
      if (record) return appRecord(runtime.app.id, runtime.version, card.id, record);
      const result = await appRuntime(runtime.app.id);
      if (!result.ok) return result;
      if (result.data.version !== runtime.version)
        return { ok: false as const, status: 409, code: 'stale_version', message: '' };
      return { ok: true as const, data: null as RecordDetail | null };
    }, [context]),
    ['records.changed', 'base.updated'],
  );
  useEffect(() => nav.addListener('beforeRemove', () => Keyboard.dismiss()), [nav]);
  useEffect(() => {
    if (!r.loading && !r.error) setLoaded(true);
  }, [r.loading, r.error]);
  const fields = context ? cardFields(context.runtime, context.card, !!context.record) : [];
  const dirty = !submitted && Object.keys(values).length > 0;
  const canSave =
    !!context &&
    !context.record &&
    !submitted &&
    !r.loading &&
    !r.error &&
    canAct(context.runtime, context.card.table_id) &&
    validValues(fields, values);
  const save = async () => {
    if (!canSave || !context || pending.current) return;
    const current = r.captureWrite();
    pending.current = true;
    setSaving(true);
    const writable = new Set(fields.filter((f) => !computed(f.type)).map((f) => f.id));
    const result = await appExecute(context.runtime.app.id, {
      version: context.runtime.version,
      card: context.card.id,
      action: 'submit',
      values: Object.fromEntries(Object.entries(values).filter(([id]) => writable.has(id))),
    });
    pending.current = false;
    if (!current()) return;
    setSaving(false);
    if (result.ok) {
      Keyboard.dismiss();
      setSubmitted(true);
      setValues({});
    } else
      alertError(
        t(result.code === 'stale_version' ? 'integration.appChanged' : 'work.saveFailed'),
        undefined,
        result.message,
      );
  };
  const reload = async () => {
    if (!context || pending.current) return;
    const current = r.captureWrite();
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
    if (!current()) return;
    pending.current = true;
    setSaving(true);
    const result = await appRuntime(context.runtime.app.id);
    pending.current = false;
    if (!current()) return;
    setSaving(false);
    const card = result.ok
      ? result.data.pages.flatMap((p) => p.cards).find((c) => c.id === context.card.id && c.kind === context.card.kind)
      : undefined;
    if (!result.ok || !card || !('fields' in card)) {
      alertError(t('work.loadFailed'), undefined, result.ok ? undefined : result.message);
      return;
    }
    Keyboard.dismiss();
    setLoaded(false);
    setValues({});
    setSubmitted(false);
    setEpoch((n) => n + 1);
    setContext({ ...context, runtime: result.data, card });
  };
  return {
    context,
    choices,
    r,
    fields,
    ready: context?.record ? !!r.data : loaded,
    values,
    saving,
    submitted,
    dirty,
    canSave,
    save,
    reload,
    epoch,
    change: (id: string, value: unknown) => {
      if (!saving && !submitted) setValues((old) => ({ ...old, [id]: value }));
    },
  };
}
