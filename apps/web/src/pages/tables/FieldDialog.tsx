/**
 * Adding or changing a field (TBL-02): name, type, and what the type needs: options with colors,
 * decimal places, one or several members, the table a relation links to. The type changes only
 * where values carry over; the primary field stays text.
 */

import { useId, useRef, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Field as FormField,
  FieldGroup,
  IconButton,
  Input,
  Overlay,
  OverlayActions,
  Select,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  FIELD_TYPES,
  isComputedType,
  OPTION_COLORS,
  type Base,
  type BaseTable,
  type Field,
  type FieldConfig,
  type FieldType,
  type FormulaError,
  type OptionColor,
  type SelectOption,
} from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useSession } from '../../app/session';
import { ComputedEditor } from './ComputedEditor';
import { useNotify } from '../../app/notify';
import { refreshBase } from '../../data/tables';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { FieldIcon } from './cells';
import { tablesError } from './errors';
import { useDraftNavigation } from './useDraftNavigation';

/** Changes the server allows without losing values (values.ts canChangeType). */
const TEXT_KINDS: readonly FieldType[] = ['text', 'long_text', 'url', 'email', 'phone'];
export function typesFrom(type: FieldType): FieldType[] {
  if (TEXT_KINDS.includes(type)) return [...TEXT_KINDS];
  if (type === 'single_select') return ['single_select', 'multi_select'];
  if (type === 'date') return ['date', 'datetime'];
  return [type];
}

const randomId = () => `o${Math.random().toString(36).slice(2, 8)}`;

export function FieldDialog({
  base,
  table,
  field,
  onClose,
}: {
  base: Base;
  table: BaseTable;
  field?: Field;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const { me } = useSession();
  const formId = useId();
  const form = useRef<HTMLFormElement>(null);
  const schemaRevision = useRef(table.schema_revision);
  const [name, setName] = useState(field?.name ?? '');
  const [type, setType] = useState<FieldType>(field?.type ?? 'text');
  const [options, setOptions] = useState<SelectOption[]>(field?.config.options ?? []);
  const [currency, setCurrency] = useState(field?.config.currency ?? '');
  const [precision, setPrecision] = useState(field?.config.precision);
  const [multiple, setMultiple] = useState(field?.config.multiple ?? type === 'relation');
  const [target, setTarget] = useState(
    field?.config.table_id ?? base.tables.find((entry) => entry.id !== table.id)?.id ?? table.id,
  );
  const [computed, setComputed] = useState<FieldConfig>(field?.config ?? {});
  const [formulaError, setFormulaError] = useState<FormulaError>();
  const [required, setRequired] = useState(field?.required ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const types = field
    ? field.is_primary
      ? [field.type]
      : typesFrom(field.type)
    : FIELD_TYPES.filter((entry) => entry !== 'ai' || me?.capabilities.llm);
  const hasParent = table.fields.some((entry) => entry.type === 'parent' && entry.id !== field?.id);
  const hasDependency = table.fields.some((entry) => entry.type === 'dependency' && entry.id !== field?.id);

  const config = (): FieldConfig => {
    if (isComputedType(type))
      return { ...computed, ...(type === 'rollup' ? { aggregate: computed.aggregate ?? 'count' } : {}) };
    switch (type) {
      case 'single_select':
      case 'multi_select':
        return { options: options.filter((option) => option.label.trim()) };
      case 'number':
        return { ...(precision === undefined ? {} : { precision }), ...(currency ? { currency } : {}) };
      case 'member':
        return { multiple };
      case 'relation':
        return { table_id: target, multiple };
      default:
        return {};
    }
  };

  const dirty =
    name !== (field?.name ?? '') ||
    type !== (field?.type ?? 'text') ||
    required !== (field?.required ?? false) ||
    JSON.stringify(config()) !== JSON.stringify(field?.config ?? {});
  const navigation = useDraftNavigation(dirty, busy, onClose);
  const close = () => {
    if (busy) return;
    if (dirty) navigation.ask();
    else onClose();
  };
  const save = async () => {
    if (!name.trim()) {
      setError(t('tables.field.nameRequired'));
      form.current?.querySelector('input')?.focus();
      return;
    }
    if (busy) return;
    if ((type === 'lookup' || type === 'rollup') && (!computed.link_field || !computed.target_field)) {
      setError(t('tables.computed.chooseFields'));
      return;
    }
    if (type === 'ai' && !computed.prompt?.trim()) {
      setError(t('tables.computed.promptRequired'));
      return;
    }
    setBusy(true);
    setFormulaError(undefined);
    setError('');
    try {
      if (field) {
        await api.tables.fields.update(field.id, {
          schema_revision: schemaRevision.current,
          name: name.trim(),
          ...(type !== field.type ? { type } : {}),
          config: config(),
          required: isComputedType(type) ? false : required,
        });
      } else {
        await api.tables.tables.createField(table.id, {
          name: name.trim(),
          type,
          config: config(),
          required: isComputedType(type) ? false : required,
        });
      }
      await refreshBase(base.id);
      onClose();
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.code === 'invalid_formula')
        setFormulaError(failure.details as FormulaError);
      else setError(tablesError(failure, t));
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!field) return;
    setBusy(true);
    try {
      await api.tables.fields.archive(field.id);
      await refreshBase(base.id);
      onClose();
      notify(t('tables.field.deleted', { name: field.name }), {
        label: t('tables.undo'),
        onClick: () => void api.tables.fields.restore(field.id).then(() => refreshBase(base.id)),
      });
    } catch (failure) {
      if (failure instanceof ApiClientError && failure.code === 'invalid_formula')
        setFormulaError(failure.details as FormulaError);
      else setError(tablesError(failure, t));
      setBusy(false);
    }
  };

  const typeOptions = types.map((entry) => ({
    value: entry,
    label: t(`tables.type.${entry}`),
    icon: <FieldIcon type={entry} />,
    disabled: (entry === 'parent' && hasParent) || (entry === 'dependency' && hasDependency),
  }));

  return (
    <Overlay
      title={field ? t('tables.field.edit') : t('tables.field.new')}
      onClose={onClose}
      beforeClose={() => {
        if (busy) return false;
        if (!dirty) return true;
        navigation.ask();
        return false;
      }}
    >
      <form
        ref={form}
        id={formId}
        className="app-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <FormField label={t('tables.field.name')} required error={error || undefined}>
          <Input data-autofocus value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </FormField>
        <FieldGroup
          label={t('tables.field.type')}
          description={field && !field.is_primary && types.length > 1 ? t('tables.field.typeLocked') : undefined}
        >
          <Select
            label={t('tables.field.type')}
            value={type}
            options={typeOptions}
            disabled={types.length < 2}
            onChange={(next) => setType(next as FieldType)}
          />
        </FieldGroup>
        {isComputedType(type) && (
          <ComputedEditor
            base={base}
            table={table}
            fieldId={field?.id}
            type={type}
            config={computed}
            onChange={(next) => {
              setComputed(next);
              setFormulaError(undefined);
            }}
            error={formulaError}
          />
        )}
        {(type === 'parent' || type === 'dependency') && (
          <p className="app-muted app-tb-note">{t('tables.field.linkHint')}</p>
        )}
        {(type === 'single_select' || type === 'multi_select') && (
          <FieldGroup label={t('tables.field.options')}>
            <ul className="app-tb-options">
              {options.map((option, index) => (
                <li key={option.id}>
                  <Select
                    label={t('tables.field.optionColor', { n: index + 1 })}
                    size="sm"
                    value={option.color}
                    options={OPTION_COLORS.map((color) => ({
                      value: color,
                      label: t(`tables.color.${color}`),
                      icon: <span className={cx('app-tb-swatch', `is-${color}`)} aria-hidden />,
                    }))}
                    onChange={(color) =>
                      setOptions(
                        options.map((entry, at) => (at === index ? { ...entry, color: color as OptionColor } : entry)),
                      )
                    }
                  />
                  <Input
                    aria-label={t('tables.field.optionLabel', { n: index + 1 })}
                    value={option.label}
                    maxLength={100}
                    onChange={(event) =>
                      setOptions(
                        options.map((entry, at) => (at === index ? { ...entry, label: event.target.value } : entry)),
                      )
                    }
                  />
                  <IconButton
                    size="sm"
                    label={t('tables.field.removeOption', { n: index + 1 })}
                    onClick={() => setOptions(options.filter((_, at) => at !== index))}
                  >
                    <Trash2 size={icon.sm} strokeWidth={icon.stroke} />
                  </IconButton>
                </li>
              ))}
            </ul>
            <Button
              size="sm"
              kind="ghost"
              onClick={() =>
                setOptions([
                  ...options,
                  { id: randomId(), label: '', color: OPTION_COLORS[options.length % OPTION_COLORS.length]! },
                ])
              }
            >
              <Plus size={icon.sm} strokeWidth={icon.stroke} />
              {t('tables.field.addOption')}
            </Button>
          </FieldGroup>
        )}
        {type === 'number' && (
          <>
            <FieldGroup label={t('tables.field.currency')}>
              <Input
                value={currency}
                maxLength={3}
                placeholder="CNY / USD"
                onChange={(event) => setCurrency(event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
              />
            </FieldGroup>
            <Select
              label={t('tables.field.precision')}
              value={precision === undefined ? '' : String(precision)}
              options={[
                { value: '', label: '—' },
                ...[0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: t('tables.field.precisionN', { n }) })),
              ]}
              onChange={(next) => setPrecision(next === '' ? undefined : Number(next))}
            />
          </>
        )}
        {type === 'relation' && (
          <FieldGroup label={t('tables.field.target')} description={t('tables.field.targetHint')}>
            <Select
              label={t('tables.field.target')}
              value={target}
              disabled={!!field}
              options={base.tables.map((entry) => ({ value: entry.id, label: entry.name }))}
              onChange={setTarget}
            />
          </FieldGroup>
        )}
        {(type === 'member' || type === 'relation') && (
          <Checkbox label={t('tables.field.multiple')} checked={multiple} onChange={setMultiple} />
        )}
        {!field?.is_primary && !isComputedType(type) && (
          <Checkbox label={t('tables.field.required')} checked={required} onChange={setRequired} />
        )}
      </form>
      <OverlayActions>
        {field && !field.is_primary && (
          <Button kind="danger" className="app-tb-action-start" loading={busy} onClick={() => void remove()}>
            {t('tables.field.delete')}
          </Button>
        )}
        <Button disabled={busy} onClick={close}>
          {t('common.cancel')}
        </Button>
        <Button kind="primary" type="submit" form={formId} loading={busy}>
          {field ? t('tables.field.save') : t('tables.field.create')}
        </Button>
      </OverlayActions>
      {navigation.asking && (
        <ConfirmDialog
          danger
          title={t('tables.record.discardTitle')}
          confirmLabel={t('tables.record.discard')}
          onCancel={navigation.cancel}
          onConfirm={navigation.discard}
        >
          {t('tables.record.discardBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
