/**
 * A data table's forms (TBL-11), for the base's builders: the list with each form's status, and
 * one form in the same drawer (‹ 返回): what it asks and how (编辑 → 取消 / 保存), who may submit
 * (分享), 发布 / 停止收集, 复制链接, and its submissions, each opening its record in the base.
 */

import { useEffect, useId, useState } from 'react';
import { ChevronLeft, CirclePause, ClipboardList, Copy, ExternalLink, Share2, Trash2 } from 'lucide-react';
import {
  Badge,
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  Input,
  Menu,
  Overlay,
  OverlayActions,
  Skeleton,
  StatusBadge,
  Tabs,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { FORM_NAME_MAX, type Base, type BaseTable, type Form } from '@greenhouse/contract';
import { useNotify } from '../../../app/notify';
import { dropForm, putForm, useFormShares, useForms } from '../../../data/tables-forms';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { href, navigate } from '../../../lib/router';
import { FieldIcon } from '../cells';
import { formsError } from './errors';
import { FormEditor } from './FormEditor';
import { FormShareDialog } from './FormShareDialog';
import { FormSubmissions } from './FormSubmissions';
import '../../../styles/tables-forms.css';

/** The address to send people: the form page of this app. */
const linkOf = (formId: string) => new URL(href({ page: 'form', id: formId }), window.location.href).href;

export function FormsDrawer({ base, table, onClose }: { base: Base; table: BaseTable; onClose: () => void }) {
  const { t } = useI18n();
  const forms = useForms(base.id, table.id);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [naming, setNaming] = useState(false);
  // What to do once the builder agrees to throw away the changes they have not saved.
  const [pending, setPending] = useState<(() => void) | null>(null);
  const items = forms.data?.items ?? [];
  const form = items.find((item) => item.id === openId);

  // A form deleted meanwhile (here or elsewhere) leaves for the list.
  useEffect(() => {
    if (openId && forms.data && !form) {
      setOpenId(null);
      setEditing(false);
    }
  }, [openId, forms.data, form]);

  const leave = (then: () => void) => {
    if (editing && dirty) setPending(() => then);
    else then();
  };
  const back = () =>
    leave(() => {
      setEditing(false);
      setDirty(false);
      setOpenId(null);
    });

  let body;
  if (forms.isPending) body = <Skeleton lines={4} />;
  else if (forms.isError) {
    body = <ErrorBox onRetry={() => void forms.refetch()}>{formsError(forms.error, t)}</ErrorBox>;
  } else if (form) {
    body = (
      <FormDetail
        base={base}
        table={table}
        form={form}
        editing={editing}
        onEditing={(next) => {
          setEditing(next);
          if (!next) setDirty(false);
        }}
        onDirty={setDirty}
        onBack={back}
        onOpenRecord={(recordId) =>
          leave(() => {
            onClose();
            navigate({ page: 'base', id: base.id, table: table.id, record: recordId });
          })
        }
      />
    );
  } else if (!items.length) {
    body = (
      <Empty
        icon={<ClipboardList strokeWidth={icon.stroke} />}
        title={t('tables.forms.none')}
        action={
          <Button kind="primary" onClick={() => setNaming(true)}>
            {t('tables.forms.new')}
          </Button>
        }
      />
    );
  } else {
    body = (
      <>
        <ul className="app-list" aria-label={t('tables.forms')}>
          {items.map((item) => (
            <li key={item.id}>
              <button type="button" className="app-list-row" onClick={() => setOpenId(item.id)}>
                <ClipboardList size={icon.md} strokeWidth={icon.stroke} aria-hidden />
                <span className="app-list-main">
                  <span className="app-list-title">{item.name}</span>
                  <span className="app-list-meta">{t('tables.forms.count', { count: item.submission_count })}</span>
                </span>
                <FormStatus form={item} />
              </button>
            </li>
          ))}
        </ul>
        <OverlayActions>
          <Button kind="primary" onClick={() => setNaming(true)}>
            {t('tables.forms.new')}
          </Button>
        </OverlayActions>
      </>
    );
  }

  return (
    <Overlay
      title={t('tables.forms.title', { table: table.name })}
      help={t('tables.forms.help')}
      onClose={onClose}
      beforeClose={() => {
        if (!(editing && dirty)) return true;
        setPending(() => onClose);
        return false;
      }}
    >
      {body}
      {naming && (
        <NewFormDialog
          base={base}
          table={table}
          onClose={() => setNaming(false)}
          onCreated={(made) => {
            setOpenId(made.id);
            setEditing(true);
          }}
        />
      )}
      {pending && (
        <ConfirmDialog
          danger
          title={t('tables.forms.discardTitle')}
          confirmLabel={t('tables.forms.discard')}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const then = pending;
            setPending(null);
            setEditing(false);
            setDirty(false);
            then();
          }}
        >
          {t('tables.forms.discardBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}

function FormStatus({ form }: { form: Pick<Form, 'status'> }) {
  const { t } = useI18n();
  return form.status === 'published' ? (
    <StatusBadge status={t('tables.forms.status.published')} tone="success" />
  ) : (
    <StatusBadge status={t('tables.forms.status.draft')} tone="neutral" />
  );
}

function NewFormDialog({
  base,
  table,
  onClose,
  onCreated,
}: {
  base: Base;
  table: BaseTable;
  onClose: () => void;
  onCreated: (form: Form) => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const create = async () => {
    if (!name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const made = await api.tables.forms.create(table.id, { name: name.trim() });
      putForm(base.id, made);
      onCreated(made);
      onClose();
    } catch (failure) {
      setError(formsError(failure, t));
      setBusy(false);
    }
  };
  return (
    <Overlay variant="dialog" title={t('tables.forms.new')} onClose={onClose}>
      <form
        id={formId}
        className="app-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Field label={t('tables.forms.name')} error={error || undefined}>
          <Input
            data-autofocus
            value={name}
            maxLength={FORM_NAME_MAX}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form={formId} loading={busy} disabled={!name.trim()}>
          {t('tables.forms.create')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

function FormDetail({
  base,
  table,
  form,
  editing,
  onEditing,
  onDirty,
  onBack,
  onOpenRecord,
}: {
  base: Base;
  table: BaseTable;
  form: Form;
  editing: boolean;
  onEditing: (editing: boolean) => void;
  onDirty: (dirty: boolean) => void;
  onBack: () => void;
  onOpenRecord: (recordId: string) => void;
}) {
  const { t } = useI18n();
  const notify = useNotify();
  const tabs = [t('tables.forms.tab.form'), t('tables.forms.tab.submissions')] as const;
  const [tab, setTab] = useState<string>(tabs[0]);
  const [sharing, setSharing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const published = form.status === 'published';

  const run = async (work: () => Promise<Form>, done: string, undo?: () => Promise<Form>) => {
    setBusy(true);
    setFailure('');
    try {
      putForm(base.id, await work());
      notify(
        done,
        undo && {
          label: t('tables.undo'),
          onClick: () =>
            void undo()
              .then((saved) => putForm(base.id, saved))
              .catch((error: unknown) => setFailure(formsError(error, t))),
        },
      );
    } catch (error) {
      setFailure(formsError(error, t));
    } finally {
      setBusy(false);
    }
  };
  const copyLink = () =>
    void navigator.clipboard
      ?.writeText(linkOf(form.id))
      .then(() => notify(t('tables.forms.linkCopied')))
      .catch(() => undefined);
  const remove = async () => {
    setRemoving(false);
    try {
      await api.tables.forms.remove(form.id);
      dropForm(base.id, form);
      notify(t('tables.forms.deleted', { name: form.name }));
    } catch (error) {
      setFailure(formsError(error, t));
    }
  };

  if (editing) {
    return (
      <div className="app-tf-detail">
        <BackButton onBack={onBack} />
        <FormEditor
          key={form.id}
          base={base}
          table={table}
          form={form}
          onDone={() => onEditing(false)}
          onDirty={onDirty}
        />
      </div>
    );
  }
  return (
    <div className="app-tf-detail">
      <BackButton onBack={onBack} />
      <div className="app-tf-head">
        <h3 className="app-tf-name">{form.name}</h3>
        <FormStatus form={form} />
      </div>
      {form.description && <p className="app-tf-description">{form.description}</p>}
      {failure && (
        <p className="app-form-error" role="alert">
          {failure}
        </p>
      )}
      <Tabs items={tabs} value={tab} onChange={setTab} label={t('tables.forms.tabs')} />
      {tab === tabs[0] ? (
        <FormSummary base={base} table={table} form={form} onShare={() => setSharing(true)} />
      ) : (
        <FormSubmissions base={base} form={form} onOpenRecord={onOpenRecord} />
      )}
      <OverlayActions>
        <Menu
          items={[
            {
              label: t('tables.forms.open'),
              icon: <ExternalLink size={icon.md} />,
              onClick: () => window.open(linkOf(form.id), '_blank', 'noopener'),
            },
            ...(published
              ? [
                  {
                    label: t('tables.forms.unpublish'),
                    icon: <CirclePause size={icon.md} />,
                    onClick: () =>
                      void run(
                        () => api.tables.forms.unpublish(form.id),
                        t('tables.forms.unpublished', { name: form.name }),
                        () => api.tables.forms.publish(form.id),
                      ),
                  },
                ]
              : []),
            '-',
            {
              label: t('tables.forms.delete'),
              icon: <Trash2 size={icon.md} />,
              danger: true,
              onClick: () => setRemoving(true),
            },
          ]}
        />
        <Button key="edit" onClick={() => onEditing(true)}>
          {t('tables.forms.edit')}
        </Button>
        {published ? (
          <Button key="copy" kind="primary" onClick={copyLink}>
            <Copy size={icon.sm} strokeWidth={icon.stroke} />
            {t('tables.forms.copyLink')}
          </Button>
        ) : (
          <Button
            key="publish"
            kind="primary"
            loading={busy}
            disabled={!form.config.fields.length}
            disabledReason={t('tables.forms.needsField')}
            onClick={() =>
              void run(() => api.tables.forms.publish(form.id), t('tables.forms.published', { name: form.name }))
            }
          >
            {t('tables.forms.publish')}
          </Button>
        )}
      </OverlayActions>
      {sharing && <FormShareDialog base={base} form={form} onClose={() => setSharing(false)} />}
      {removing && (
        <ConfirmDialog
          danger
          title={t('tables.forms.deleteTitle', { name: form.name })}
          confirmLabel={t('tables.forms.delete')}
          onCancel={() => setRemoving(false)}
          onConfirm={() => void remove()}
        >
          {t('tables.forms.deleteBody')}
        </ConfirmDialog>
      )}
    </div>
  );
}

function BackButton({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  return (
    <button type="button" className="app-tf-back" onClick={onBack}>
      <ChevronLeft size={icon.md} strokeWidth={icon.stroke} aria-hidden />
      {t('tables.forms.back')}
    </button>
  );
}

/** Who may submit, the fields in order, and what submitting looks like. */
function FormSummary({
  base,
  table,
  form,
  onShare,
}: {
  base: Base;
  table: BaseTable;
  form: Form;
  onShare: () => void;
}) {
  const { t } = useI18n();
  const shares = useFormShares(base.id, form.id);
  const whoId = useId();
  const fieldsId = useId();
  const submitId = useId();
  const byId = new Map(table.fields.map((field) => [field.id, field]));
  const names = (shares.data?.items ?? []).map((entry) =>
    entry.type === 'workspace' ? t('tables.share.everyone') : entry.name,
  );
  return (
    <div className="app-tf-sections">
      <section className="app-tf-section" aria-labelledby={whoId}>
        <div className="app-section-heading">
          <h4 id={whoId} className="app-tf-section-title">
            {t('tables.forms.who')}
          </h4>
          <Button size="sm" onClick={onShare}>
            <Share2 size={icon.sm} strokeWidth={icon.stroke} />
            {t('tables.forms.share')}
          </Button>
        </div>
        {shares.isPending ? (
          <Skeleton lines={1} />
        ) : shares.isError ? (
          <ErrorBox onRetry={() => void shares.refetch()}>{formsError(shares.error, t)}</ErrorBox>
        ) : (
          <p className="app-tf-note">
            {names.length ? t('tables.forms.whoShared', { names: names.join('、') }) : t('tables.forms.whoDefault')}
          </p>
        )}
      </section>
      <section className="app-tf-section" aria-labelledby={fieldsId}>
        <h4 id={fieldsId} className="app-tf-section-title">
          {t('tables.forms.fields')}
        </h4>
        {form.config.fields.length ? (
          <ol className="app-tf-summary">
            {form.config.fields.map((item) => {
              const field = byId.get(item.field_id);
              if (!field) return null;
              const label = item.label || field.name;
              return (
                <li key={item.field_id}>
                  <FieldIcon type={field.type} />
                  <span className="app-tf-summary-main">
                    <span className="app-tf-summary-label">
                      {label}
                      {(item.required || field.required) && <Badge>{t('tables.forms.required')}</Badge>}
                    </span>
                    {(label !== field.name || item.help) && (
                      <span className="app-tf-summary-meta">
                        {[label !== field.name ? field.name : '', item.help ?? ''].filter(Boolean).join(' · ')}
                      </span>
                    )}
                  </span>
                </li>
              );
            })}
          </ol>
        ) : (
          <p className="app-tf-note">{t('tables.forms.noFields')}</p>
        )}
      </section>
      <section className="app-tf-section" aria-labelledby={submitId}>
        <h4 id={submitId} className="app-tf-section-title">
          {t('tables.forms.submitting')}
        </h4>
        <dl className="app-tf-settings">
          <div>
            <dt>{t('tables.forms.submitLabel')}</dt>
            <dd>{form.config.submit_label || t('tables.forms.defaultSubmit')}</dd>
          </div>
          <div>
            <dt>{t('tables.forms.successMessage')}</dt>
            <dd>{form.config.success_message || t('tables.forms.defaultThanks')}</dd>
          </div>
        </dl>
        <p className="app-tf-note">
          {form.config.single_submit ? t('tables.forms.single') : t('tables.forms.multiple')}
        </p>
      </section>
    </div>
  );
}
