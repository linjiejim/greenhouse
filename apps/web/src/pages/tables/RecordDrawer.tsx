/**
 * A record in the drawer (TBL-07; a bottom sheet on phones): its fields, its children, then
 * comments and history. 「编辑」 turns the same drawer into a form with 取消 / 保存
 * (patterns.md, 列表与详情); a save based on an older revision offers 重新载入 or 覆盖. A new
 * record opens straight in the form.
 */

import { useEffect, useId, useMemo, useState } from 'react';
import { Copy, Plus, Trash2 } from 'lucide-react';
import {
  Banner,
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field as FormField,
  FieldGroup,
  Menu,
  Overlay,
  OverlayActions,
  Skeleton,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import {
  isEmptyValue,
  isComputedType,
  type Base,
  type BaseTable,
  type Field,
  type RecordFile,
  type RecordValues,
  type TableRecord,
} from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { createRecord, deleteRecords, putRecords, restoreRecord, tablesKeys, useRecord } from '../../data/tables';
import { queryClient } from '../../data/query';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { Activity } from './Activity';
import { CellValue, FieldInput, fromText } from './cells';
import { tablesError } from './errors';
import { useDraftNavigation } from './useDraftNavigation';
import { titleOf, type CellLookups } from './model';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The table's fields in its own order, the primary one first. */
const inOrder = (fields: readonly Field[]) =>
  [...fields].sort((a, b) => Number(b.is_primary) - Number(a.is_primary) || a.position - b.position);

function RecordForm({
  fields,
  base,
  values,
  lookups,
  recordId,
  errors,
  onChange,
  onFiles,
}: {
  fields: Field[];
  base: Base;
  values: RecordValues;
  lookups: CellLookups;
  recordId?: string;
  errors: Record<string, string>;
  onChange: (field: Field, value: unknown) => void;
  onFiles: (files: RecordFile[]) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="app-tb-record-form" role="group" aria-label={t('tables.record.fieldsLabel')}>
      {inOrder(fields).map((field) => {
        const control = (
          <FieldInput
            field={field}
            value={values[field.id]}
            baseId={base.id}
            lookups={lookups}
            recordId={recordId}
            onFiles={onFiles}
            onChange={(value) => onChange(field, value)}
          />
        );
        // Composite controls (pickers, files) get a group label; plain ones a field label.
        return ['text', 'long_text', 'number', 'url', 'email', 'phone'].includes(field.type) ? (
          <FormField key={field.id} label={field.name} required={field.required} error={errors[field.id]}>
            {control}
          </FormField>
        ) : (
          <FieldGroup key={field.id} label={field.name} error={errors[field.id]}>
            {control}
          </FieldGroup>
        );
      })}
    </div>
  );
}

export function RecordDrawer({
  base,
  table,
  recordId,
  initial,
  canEdit,
  canGenerate = false,
  lookups,
  onOpen,
  onCreated,
  onClose,
}: {
  base: Base;
  table: BaseTable;
  recordId?: string;
  /** A new record with these values; opens in the form. */
  initial?: RecordValues;
  canEdit: boolean;
  canGenerate?: boolean;
  lookups: CellLookups;
  onOpen: (id: string) => void;
  onCreated: (record: TableRecord) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const formId = useId();
  const detail = useRecord(recordId);
  const creating = !recordId;
  const [editing, setEditing] = useState(creating);
  const [draft, setDraft] = useState<RecordValues>(initial ?? {});
  const [files, setFiles] = useState<Record<string, RecordFile>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState('');
  const [stale, setStale] = useState<TableRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);
  const record = detail.data?.record;
  const fields = table.fields;

  // A record of another table (a linked one opened from here) opens on its own table.
  const elsewhere = detail.data && detail.data.table_id !== table.id;
  useEffect(() => {
    if (elsewhere && detail.data) {
      navigate(
        { page: 'base', id: base.id, table: detail.data.table_id, record: detail.data.record.id },
        { replace: true },
      );
    }
  }, [elsewhere, detail.data, base.id]);
  const merged: CellLookups = useMemo(
    () => ({
      ...lookups,
      linked: { ...lookups.linked, ...detail.data?.linked },
      files: { ...lookups.files, ...detail.data?.files, ...files },
    }),
    [lookups, detail.data, files],
  );

  useEffect(() => {
    if (record && !editing) setDraft(record.values);
  }, [record, editing]);

  const changed = useMemo(() => {
    const base = record?.values ?? {};
    const out: RecordValues = {};
    for (const field of fields) {
      if (isComputedType(field.type)) continue;
      const value = fromText(field, draft[field.id]);
      if (!same(value, base[field.id]) && !(isEmptyValue(value) && isEmptyValue(base[field.id]))) out[field.id] = value;
    }
    return out;
  }, [draft, record, fields]);
  const dirty = editing && Object.keys(changed).length > 0;

  const navigation = useDraftNavigation(dirty, busy, (navigating) => {
    setEditing(false);
    setDraft(record?.values ?? {});
    if (!navigating || creating) onClose();
  });

  const save = async (over?: TableRecord) => {
    if (!creating && !over && !Object.keys(changed).length) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setFailure('');
    setErrors({});
    try {
      if (creating) {
        const made = await createRecord(table.id, changed);
        notify(t('tables.record.created'));
        onCreated(made.record);
        return;
      }
      const target = over ?? record!;
      const saved = await api.tables.records.update(target.id, target.revision, changed);
      putRecords(table.id, [saved.record], saved);
      void queryClient.invalidateQueries({ queryKey: tablesKeys.activity(target.id) });
      setStale(null);
      setEditing(false);
    } catch (error) {
      if (error instanceof ApiClientError && error.code === 'stale_revision') {
        setStale((error.details as { record?: TableRecord } | undefined)?.record ?? null);
      } else if (error instanceof ApiClientError && (error.details as { field?: string } | undefined)?.field) {
        setErrors({ [(error.details as { field: string }).field]: tablesError(error, t) });
      } else setFailure(tablesError(error, t));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!record) return;
    try {
      await deleteRecords(table.id, [record.id]);
      onClose();
      notify(t('tables.record.deleted'), {
        label: t('tables.undo'),
        onClick: () => void restoreRecord(table.id, record.id),
      });
    } catch (error) {
      setFailure(tablesError(error, t));
    }
  };

  const title = creating
    ? t('tables.record.new')
    : record
      ? titleOf(fields, record) || t('tables.record.untitled')
      : t('tables.record.untitled');
  const parent = fields.find((field) => field.type === 'parent');

  let body;
  if (!creating && detail.isPending) body = <Skeleton lines={6} />;
  else if (!creating && (detail.isError || elsewhere)) {
    body =
      detail.error instanceof ApiClientError && detail.error.status < 500 ? (
        <Empty title={t('tables.record.notFound')} />
      ) : elsewhere ? (
        <Empty title={t('tables.record.notFound')} />
      ) : (
        <ErrorBox onRetry={() => void detail.refetch()}>{tablesError(detail.error, t)}</ErrorBox>
      );
  } else if (editing) {
    body = (
      <form
        id={formId}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {stale && (
          <Banner
            tone="warning"
            action={
              <span className="app-inline-actions">
                <Button
                  size="sm"
                  onClick={() => {
                    putRecords(table.id, [stale]);
                    void detail.refetch();
                    setDraft(stale.values);
                    setStale(null);
                  }}
                >
                  {t('tables.record.reload')}
                </Button>
                <Button size="sm" kind="primary" onClick={() => void save(stale)}>
                  {t('tables.record.overwrite')}
                </Button>
              </span>
            }
          >
            {t('tables.record.stale')}
          </Banner>
        )}
        {failure && (
          <p className="app-form-error" role="alert">
            {failure}
          </p>
        )}
        <RecordForm
          fields={fields}
          base={base}
          values={draft}
          lookups={merged}
          recordId={recordId}
          errors={errors}
          onFiles={(stored) =>
            setFiles((current) => ({ ...current, ...Object.fromEntries(stored.map((file) => [file.id, file])) }))
          }
          onChange={(field, value) => setDraft((current) => ({ ...current, [field.id]: value }))}
        />
      </form>
    );
  } else if (record) {
    body = (
      <div className="app-tb-record">
        {failure && (
          <p className="app-form-error" role="alert">
            {failure}
          </p>
        )}
        <dl className="app-tb-record-fields">
          {inOrder(fields).map((field) => (
            <div key={field.id} className="app-tb-record-field">
              <dt>{field.name}</dt>
              <dd>
                {isEmptyValue(record.values[field.id]) && field.type !== 'checkbox' ? (
                  <span className="app-muted">{t('tables.record.empty')}</span>
                ) : (
                  <CellValue field={field} value={record.values[field.id]} lookups={merged} onOpenRecord={onOpen} />
                )}
                {field.type === 'ai' && canEdit && canGenerate && (
                  <Button
                    size="sm"
                    kind="ghost"
                    loading={generating === field.id}
                    disabled={generating !== null && generating !== field.id}
                    onClick={async () => {
                      setGenerating(field.id);
                      setFailure('');
                      try {
                        await api.tables.fields.generate(field.id, [record.id]);
                        await Promise.all([
                          detail.refetch(),
                          queryClient.invalidateQueries({ queryKey: tablesKeys.records(table.id) }),
                        ]);
                      } catch (error) {
                        setFailure(tablesError(error, t));
                      } finally {
                        setGenerating(null);
                      }
                    }}
                  >
                    {t('tables.computed.regenerate')}
                  </Button>
                )}
              </dd>
            </div>
          ))}
        </dl>
        {parent && detail.data && (
          <section className="app-tb-children" aria-label={t('tables.record.children')}>
            <h3 className="app-section-title">{t('tables.record.children')}</h3>
            {detail.data.children.length > 0 && (
              <ul>
                {detail.data.children.map((child) => (
                  <li key={child.id}>
                    <button type="button" className="app-tb-record-chip" onClick={() => onOpen(child.id)}>
                      {child.title || t('tables.record.untitled')}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {canEdit && (
              <Button
                size="sm"
                kind="ghost"
                onClick={() =>
                  void createRecord(table.id, { [parent.id]: [record.id] })
                    .then((made) => {
                      void detail.refetch();
                      onOpen(made.record.id);
                    })
                    .catch((error: unknown) => setFailure(tablesError(error, t)))
                }
              >
                <Plus size={icon.sm} strokeWidth={icon.stroke} />
                {t('tables.record.addChild')}
              </Button>
            )}
          </section>
        )}
        <Activity base={base} table={table} recordId={record.id} lookups={merged} />
      </div>
    );
  }

  return (
    <Overlay
      title={title}
      onClose={onClose}
      beforeClose={() => {
        if (!dirty) return true;
        navigation.ask();
        return false;
      }}
    >
      {body}
      <OverlayActions>
        {editing ? (
          <>
            <Button
              onClick={() => {
                if (creating) return onClose();
                setDraft(record?.values ?? {});
                setEditing(false);
                setStale(null);
                setErrors({});
              }}
            >
              {t('tables.record.cancel')}
            </Button>
            {/* Keyed apart from 编辑: a reused button would turn into this submit while 编辑's click runs. */}
            <Button key="save" kind="primary" type="submit" form={formId} loading={busy}>
              {creating ? t('tables.record.create') : t('tables.record.save')}
            </Button>
          </>
        ) : record ? (
          <>
            <Menu
              label={t('tables.record.more')}
              items={[
                {
                  label: t('tables.record.copyLink'),
                  icon: <Copy size={icon.md} />,
                  onClick: () =>
                    void navigator.clipboard
                      ?.writeText(location.href)
                      .then(() => notify(t('tables.record.linkCopied')))
                      .catch(() => undefined),
                },
                ...(canEdit
                  ? [
                      '-' as const,
                      {
                        label: t('tables.record.delete'),
                        icon: <Trash2 size={icon.md} />,
                        danger: true,
                        onClick: () => void remove(),
                      },
                    ]
                  : []),
              ]}
            />
            {canEdit && (
              <Button key="edit" kind="primary" onClick={() => setEditing(true)}>
                {t('tables.record.edit')}
              </Button>
            )}
          </>
        ) : null}
      </OverlayActions>
      {navigation.asking && (
        <ConfirmDialog
          title={t('tables.record.discardTitle')}
          confirmLabel={t('tables.record.discard')}
          danger
          onCancel={navigation.cancel}
          onConfirm={navigation.discard}
        >
          {t('tables.record.discardBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
