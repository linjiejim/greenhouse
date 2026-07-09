/**
 * CrudForm — the add/edit form derived from schema.formFields. Renders in a
 * Dialog (default) or a right Drawer, lays fields out on a 4-column grid, runs
 * required + rule validation before submit, and posts only the visible input
 * fields through the data source. Exported standalone so a bespoke page can
 * embed just the form.
 */

import React, { useMemo, useState } from 'react';
import { Button, Dialog, Drawer, Spinner, toast } from '@greenhouse/ui/components/ui';
import { useT } from '@greenhouse/ui/lib/i18n';

import type { FieldDef, ResolvedCrudSchema } from './schema.js';
import { fieldsForMode, formDefaults } from './schema.js';
import { CrudFieldInput } from './fields.js';
import { tr } from './util.js';

export interface CrudFormProps<TRow> {
  schema: ResolvedCrudSchema<TRow>;
  mode: 'add' | 'edit';
  initial?: TRow | null;
  onClose: () => void;
  onSaved: () => void;
}

const SPAN: Record<number, string> = {
  1: 'col-span-4 sm:col-span-1',
  2: 'col-span-4 sm:col-span-2',
  3: 'col-span-4 sm:col-span-3',
  4: 'col-span-4',
};

export function CrudForm<TRow>({ schema, mode, initial, onClose, onSaved }: CrudFormProps<TRow>) {
  const t = useT();
  const fields = useMemo(() => fieldsForMode(schema.formFields, mode), [schema.formFields, mode]);

  const [form, setForm] = useState<Record<string, unknown>>(() => ({
    ...formDefaults(schema.formFields),
    ...((initial as Record<string, unknown>) ?? {}),
  }));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<string>(schema.formTabs[0]?.key ?? '');

  const setValue = (key: string, value: unknown) => setForm((f) => ({ ...f, [key]: value }));

  const isVisible = (f: FieldDef<TRow>): boolean => {
    if (f.type === 'divider') return true;
    return typeof f.visible === 'function' ? f.visible(form) : true;
  };

  const validate = (): boolean => {
    const next: Record<string, string> = {};
    for (const f of fields) {
      if (f.type === 'divider' || !isVisible(f)) continue;
      const value = form[f.key];
      if (
        f.required &&
        (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0))
      ) {
        next[f.key] = t('crud.required');
        continue;
      }
      for (const rule of f.rules ?? []) {
        const msg = rule.validate(value, form);
        if (msg) {
          next[f.key] = msg;
          break;
        }
      }
    }
    setErrors(next);
    return Object.keys(next).length === 0;
  };

  const handleSave = async () => {
    if (!validate()) return;
    // Submit only visible, non-divider input fields.
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      if (f.type === 'divider' || f.type === 'readonly' || !isVisible(f)) continue;
      payload[f.key] = form[f.key];
    }
    setSaving(true);
    try {
      if (mode === 'add') {
        if (!schema.dataSource.create) throw new Error('create not supported');
        await schema.dataSource.create(payload);
        toast(t('crud.created'), 'success');
      } else {
        if (!schema.dataSource.update) throw new Error('update not supported');
        const id = String((initial as Record<string, unknown>)[schema.idField]);
        await schema.dataSource.update(id, payload);
        toast(t('crud.updated'), 'success');
      }
      onSaved();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('crud.saveFailed'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const title = schema.formTitle
    ? schema.formTitle(mode, initial ?? null)
    : `${mode === 'add' ? t('crud.add') : t('crud.edit')} ${tr(t, schema.name)}`;

  const visibleFields = fields.filter(
    (f) =>
      isVisible(f) && (!schema.formTabs.length || f.type === 'divider' || !('tab' in f) || !f.tab || f.tab === tab),
  );

  const body = (
    <div className="space-y-4">
      {schema.formTabs.length > 0 && (
        <div className="flex gap-1 border-b border-edge -mt-1">
          {schema.formTabs.map((tb) => (
            <button
              key={tb.key}
              onClick={() => setTab(tb.key)}
              className={`px-3 py-1.5 text-sm border-b-2 -mb-px transition-colors ${
                tab === tb.key ? 'border-primary-500 text-fg' : 'border-transparent text-fg-muted hover:text-fg'
              }`}
            >
              {tr(t, tb.label)}
            </button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-4 gap-3">
        {visibleFields.map((f, i) => {
          if (f.type === 'divider') {
            return (
              <div key={`div-${i}`} className="col-span-4 pt-1">
                {f.label && (
                  <div className="text-xs font-semibold text-fg-muted uppercase tracking-wide mb-1">
                    {tr(t, f.label)}
                  </div>
                )}
                <hr className="border-edge" />
              </div>
            );
          }
          const disabled = typeof f.disabled === 'function' ? f.disabled(form) : false;
          return (
            <div key={f.key} className={SPAN[f.width ?? 4]}>
              <label className="block text-xs font-medium text-fg-secondary mb-1">
                {tr(t, f.label)}
                {f.required && <span className="text-danger ml-0.5">*</span>}
              </label>
              <CrudFieldInput
                field={f}
                value={form[f.key]}
                onChange={(v) => setValue(f.key, v)}
                form={form}
                mode={mode}
                disabled={disabled}
                testId={schema.testId ? `${schema.testId}-field-${f.key}` : undefined}
              />
              {f.comment && <p className="text-[11px] text-fg-faint mt-0.5">{tr(t, f.comment)}</p>}
              {errors[f.key] && <p className="text-[11px] text-danger mt-0.5">{errors[f.key]}</p>}
            </div>
          );
        })}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={onClose}
          disabled={saving}
          data-testid={schema.testId ? `${schema.testId}-cancel` : undefined}
        >
          {t('crud.cancel')}
        </Button>
        <Button
          size="sm"
          onClick={handleSave}
          disabled={saving}
          data-testid={schema.testId ? `${schema.testId}-submit` : undefined}
        >
          {saving ? <Spinner className="mr-1" /> : null}
          {mode === 'add' ? t('crud.create') : t('crud.save')}
        </Button>
      </div>
    </div>
  );

  if (schema.formMode === 'drawer') {
    return (
      <Drawer open onClose={onClose} side="right" width={520}>
        <div className="p-4 h-full overflow-y-auto">
          <h2 className="text-base font-semibold text-fg mb-3">{title}</h2>
          {body}
        </div>
      </Drawer>
    );
  }

  return (
    <Dialog open onClose={onClose} title={title} size="md">
      {body}
    </Dialog>
  );
}
