/**
 * The quick-add form's behaviour, shared by app/tables/new-record.tsx (SwiftUI) and its Android
 * sibling: the table's schema, the draft of the simple fields (src/data/table-fields.ts), and
 * saving — bound to the station and account that opened the form.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ApiMiss } from '../api/client';
import { createRecord, getSchema } from '../api/tables';
import { captureIdentity } from '../data/identity';
import { draftValues, liveFields, quickAddFields, type Draft } from '../data/table-fields';
import { useT } from '../lib/i18n';
import type { TableSchema } from '../shared/greenhouse-types';
import { alertError } from '../ui/dialogs';
import { notifySuccess } from '../ui/haptics';
import { toast } from '../ui/toast';

export function useNewRecord(tableId: string | null) {
  const t = useT();
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [error, setError] = useState<ApiMiss | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const [saving, setSaving] = useState(false);
  /** The record was added: nothing is left to lose, the sheet may close without asking. */
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (tableId == null) return;
    let alive = true;
    const current = captureIdentity();
    setError(null);
    void getSchema(tableId).then((result) => {
      if (!alive || !current()) return;
      if (result.ok) setSchema(result.data);
      else setError(result);
    });
    return () => {
      alive = false;
    };
  }, [tableId, attempt]);

  const fields = useMemo(() => (schema ? quickAddFields(schema.fields) : []), [schema]);
  const readOnlyCount = schema ? liveFields(schema.fields).length - fields.length : 0;
  const dirty = !saved && Object.values(draft).some((value) => value !== '' && value !== null && value !== undefined && value !== false);

  const set = useCallback((fieldId: string, value: string | boolean | null) => {
    setDraft((before) => ({ ...before, [String(fieldId)]: value }));
  }, []);

  /** Save the record; true when it was added (then `saved` turns on and the sheet closes). */
  const submit = useCallback(async (): Promise<boolean> => {
    if (tableId == null || !schema || saving) return false;
    const built = draftValues(schema.fields, draft);
    if (!built.ok) {
      const { kind, field } = built.problem;
      alertError(
        t(kind === 'required' ? 'tables.required' : kind === 'number' ? 'tables.invalidNumber' : 'tables.invalidDate', {
          field,
        }),
      );
      return false;
    }
    const current = captureIdentity();
    setSaving(true);
    const result = await createRecord(tableId, built.values);
    if (!current()) return false;
    setSaving(false);
    if (!result.ok) {
      alertError(t('tables.addFailed'), result.message || undefined);
      return false;
    }
    notifySuccess();
    toast(t('tables.added'), 'check');
    setSaved(true);
    return true;
  }, [tableId, schema, saving, draft, t]);

  return {
    schema,
    fields,
    readOnlyCount,
    draft,
    dirty,
    set,
    submit,
    saving,
    saved,
    error,
    retry: () => setAttempt((n) => n + 1),
  };
}
