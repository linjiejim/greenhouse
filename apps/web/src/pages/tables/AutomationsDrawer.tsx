import { useSession } from '../../app/session';
import { navigate } from '../../lib/router';
import { useState } from 'react';
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  FieldGroup,
  Input,
  MultiSelect,
  Overlay,
  OverlayActions,
  Select,
  TextArea,
} from '@greenhouse/ui/kit';
import {
  AUTOMATION_TRIGGERS,
  type Automation,
  type AutomationInput,
  type Base,
  type BaseTable,
} from '@greenhouse/contract';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { useAgents } from '../../data/agents';
import { usePeople } from '../../data/people';
import { tablesError } from './errors';
import { CardFilter } from './dashboards/CardFilter';
import { useDraftNavigation } from '../../lib/useDraftNavigation';

export function AutomationsDrawer({ base, table, onClose }: { base: Base; table: BaseTable; onClose: () => void }) {
  const { t } = useI18n();
  const client = useQueryClient();
  const key = ['tables', 'automations', base.id];
  const list = useInfiniteQuery({
    queryKey: key,
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.tables.automations.list(base.id, { cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
  });
  const [editing, setEditing] = useState<Automation | 'new' | null>(null);
  const [history, setHistory] = useState<Automation | null>(null);
  const [error, setError] = useState('');
  const change = useMutation({
    mutationFn: async (rule: Automation) =>
      api.tables.automations.update(rule.id, { ...rule, status: rule.status === 'active' ? 'paused' : 'active' }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });
  if (editing)
    return (
      <AutomationEditor
        base={base}
        table={table}
        initial={editing === 'new' ? undefined : editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void client.invalidateQueries({ queryKey: key });
        }}
      />
    );
  if (history) return <AutomationHistory rule={history} onClose={() => setHistory(null)} />;
  return (
    <>
      <Overlay title={t('tables.automations')} onClose={onClose}>
        <div className="app-stack">
          <Button kind="primary" onClick={() => setEditing('new')}>
            {t('tables.automation.new')}
          </Button>
          {error && (
            <p role="alert" className="app-form-error">
              {error}
            </p>
          )}
          {list.isError && <ErrorBox onRetry={() => void list.refetch()}>{tablesError(list.error, t)}</ErrorBox>}
          {list.data?.pages
            .flatMap((p) => p.items)
            .map((rule) => (
              <div className="app-stack app-tb-automation" key={rule.id}>
                <strong>{rule.name}</strong>
                <span className="app-muted">
                  {t(`tables.automation.${rule.trigger}`)} ·{' '}
                  {t(rule.status === 'active' ? 'tables.automation.active' : 'tables.automation.paused')}
                </span>
                <div className="app-inline-actions">
                  <Button size="sm" onClick={() => setEditing(rule)}>
                    {t('tables.record.edit')}
                  </Button>
                  <Button size="sm" onClick={() => setHistory(rule)}>
                    {t('tables.automation.history')}
                  </Button>
                  <Button size="sm" disabled={change.isPending} onClick={() => change.mutate(rule)}>
                    {t(rule.status === 'active' ? 'tables.automation.pause' : 'tables.automation.enable')}
                  </Button>
                  {rule.trigger === 'button' && (
                    <Button
                      size="sm"
                      onClick={() =>
                        void api.tables.automations.run(rule.id).then(
                          () => setHistory(rule),
                          (e) => setError(tablesError(e, t)),
                        )
                      }
                    >
                      {t('tables.automation.run')}
                    </Button>
                  )}
                </div>
              </div>
            ))}
          {list.data?.pages[0]?.items.length === 0 && <Empty title={t('tables.automation.empty')} />}
          {list.hasNextPage && <Button onClick={() => void list.fetchNextPage()}>{t('clients.more')}</Button>}
        </div>
      </Overlay>
    </>
  );
}

function AutomationEditor({
  base,
  table,
  initial,
  onClose,
  onSaved,
}: {
  base: Base;
  table: BaseTable;
  initial?: Automation;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const agents = useAgents();
  const { me } = useSession();
  const people = usePeople();
  const first = initial?.config.actions[0];
  const [name, setName] = useState(initial?.name ?? '');
  const [trigger, setTrigger] = useState<AutomationInput['trigger']>(initial?.trigger ?? 'record_created');
  const [actionType, setActionType] = useState<'notify' | 'agent' | 'webhook'>(first?.type ?? 'notify');
  const [target, setTarget] = useState(
    first?.type === 'agent'
      ? first.agent_id
      : first?.type === 'notify'
        ? (first.members[0] ?? me?.id ?? base.owner_id)
        : (me?.id ?? base.owner_id),
  );
  const [content, setContent] = useState(
    first?.type === 'agent' ? first.brief : first?.type === 'notify' ? first.title : (first?.url ?? ''),
  );
  const [tools, setTools] = useState(first?.type === 'agent' ? first.tools : 'none');
  const [recipients, setRecipients] = useState(first?.type === 'notify' ? first.members : [me?.id ?? base.owner_id]);
  const [outputField, setOutputField] = useState(first?.type === 'agent' ? (first.output_field_id ?? '') : '');
  const [interval, setInterval] = useState(String(initial?.config.interval_minutes ?? 60));
  const [dateField, setDateField] = useState(initial?.config.date_field_id ?? '');
  const [filter, setFilter] = useState(initial?.config.filter);
  const [fields, setFields] = useState(initial?.config.fields ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');
  const [dirty, setDirty] = useState(false);
  const navigation = useDraftNavigation(dirty, busy, onClose);
  const source = base.tables.find((tab) => tab.id === initial?.table_id) ?? table;
  const targets =
    actionType === 'agent'
      ? agents.items.map((a) => ({ value: a.id, label: a.name }))
      : people.members.map((p) => ({ value: p.id, label: p.name }));
  return (
    <Overlay
      title={t('tables.automation.editor')}
      onClose={onClose}
      beforeClose={() => {
        if (!dirty) return true;
        navigation.ask();
        return false;
      }}
    >
      {secret ? (
        <div className="app-stack">
          <p>{t('tables.automation.secretHint')}</p>
          <code className="app-tb-webhook-secret">{secret}</code>
          <Button onClick={onSaved}>{t('common.close')}</Button>
        </div>
      ) : (
        <form
          id="automation-editor"
          className="app-stack"
          onChange={() => setDirty(true)}
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError('');
            try {
              const action =
                actionType === 'agent'
                  ? {
                      type: 'agent' as const,
                      agent_id: target || targets[0]?.value || '',
                      brief: content,
                      tools: tools as 'none' | 'same_base_read',
                      output_field_id: outputField || undefined,
                    }
                  : actionType === 'notify'
                    ? { type: 'notify' as const, members: recipients, title: content }
                    : { type: 'webhook' as const, url: content };
              const input: AutomationInput = {
                table_id: source.id,
                name,
                trigger,
                status: initial?.status ?? 'active',
                config: {
                  filter,
                  fields,
                  interval_minutes: Number(interval),
                  date_field_id: dateField || undefined,
                  actions: [action, ...(initial?.config.actions.slice(1) ?? [])],
                },
              };
              const saved = initial
                ? await api.tables.automations.update(initial.id, { ...input, revision: initial.revision })
                : await api.tables.automations.create(base.id, input);
              setDirty(false);
              if ('webhook_secret' in saved && typeof saved.webhook_secret === 'string')
                setSecret(saved.webhook_secret);
              else onSaved();
            } catch (failure) {
              setError(tablesError(failure, t));
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label={t('tables.automation.name')}>
            <Input value={name} required maxLength={100} onChange={(e) => setName(e.target.value)} />
          </Field>
          <FieldGroup label={t('tables.automation.trigger')}>
            <Select
              label={t('tables.automation.trigger')}
              value={trigger}
              options={AUTOMATION_TRIGGERS.map((value) => ({ value, label: t(`tables.automation.${value}`) }))}
              onChange={(value) => {
                setTrigger(value as typeof trigger);
                setDirty(true);
              }}
            />
          </FieldGroup>
          {trigger === 'schedule' && (
            <Field label={t('tables.automation.interval')}>
              <Input
                type="number"
                min={1}
                max={525600}
                value={interval}
                onChange={(e) => setInterval(e.target.value)}
              />
            </Field>
          )}
          {trigger === 'date_reached' && (
            <FieldGroup label={t('tables.automation.dateField')}>
              <Select
                label={t('tables.automation.dateField')}
                value={dateField}
                options={source.fields
                  .filter((f) => ['date', 'datetime'].includes(f.type))
                  .map((f) => ({ value: f.id, label: f.name }))}
                onChange={(value) => {
                  setDateField(value);
                  setDirty(true);
                }}
              />
            </FieldGroup>
          )}
          {trigger === 'record_updated' && (
            <FieldGroup label={t('tables.automation.changedField')}>
              <Select
                label={t('tables.automation.changedField')}
                value={fields[0] ?? ''}
                options={[
                  { value: '', label: t('tables.automation.anyField') },
                  ...source.fields.map((f) => ({ value: f.id, label: f.name })),
                ]}
                onChange={(value) => {
                  setFields(value ? [value] : []);
                  setDirty(true);
                }}
              />
            </FieldGroup>
          )}
          {trigger !== 'schedule' && (
            <CardFilter
              fields={source.fields}
              filter={filter}
              onChange={(value) => {
                setFilter(value);
                setDirty(true);
              }}
            />
          )}
          <FieldGroup label={t('tables.automation.action')}>
            <Select
              label={t('tables.automation.action')}
              value={actionType}
              options={(['notify', 'agent', 'webhook'] as const).map((value) => ({
                value,
                label: t(`tables.automation.${value}`),
              }))}
              onChange={(value) => {
                setActionType(value as typeof actionType);
                setTarget(value === 'notify' ? (me?.id ?? base.owner_id) : '');
                setContent('');
                setDirty(true);
              }}
            />
          </FieldGroup>
          {actionType === 'agent' && (
            <FieldGroup label={t(actionType === 'agent' ? 'tables.automation.agent' : 'tables.automation.member')}>
              <Select
                label={t('tables.automation.member')}
                value={target || targets[0]?.value || ''}
                options={targets}
                onChange={(value) => {
                  setTarget(value);
                  setDirty(true);
                }}
              />
            </FieldGroup>
          )}
          {actionType === 'notify' && (
            <FieldGroup label={t('tables.automation.member')}>
              <MultiSelect
                label={t('tables.automation.member')}
                value={recipients}
                options={targets}
                onChange={(value) => {
                  setRecipients(value);
                  setDirty(true);
                }}
              />
            </FieldGroup>
          )}
          <Field
            label={t(
              actionType === 'agent'
                ? 'tables.automation.brief'
                : actionType === 'notify'
                  ? 'tables.automation.title'
                  : 'tables.automation.url',
            )}
          >
            <TextArea
              value={content}
              required
              maxLength={actionType === 'agent' ? 4000 : actionType === 'webhook' ? 2000 : 200}
              onChange={(e) => setContent(e.target.value)}
            />
          </Field>
          {actionType === 'agent' && (
            <FieldGroup label={t('tables.automation.tools')}>
              <Select
                label={t('tables.automation.tools')}
                value={tools}
                options={[
                  { value: 'none', label: t('tables.automation.noTools') },
                  { value: 'same_base_read', label: t('tables.automation.baseRead') },
                ]}
                onChange={(value) => {
                  setTools(value as typeof tools);
                  setDirty(true);
                }}
              />
            </FieldGroup>
          )}
          {actionType === 'agent' && (
            <FieldGroup label={t('tables.automation.outputField')}>
              <Select
                label={t('tables.automation.outputField')}
                value={outputField}
                options={[
                  { value: '', label: t('tables.automation.reportOnly') },
                  ...source.fields
                    .filter((f) => ['text', 'long_text'].includes(f.type))
                    .map((f) => ({ value: f.id, label: f.name })),
                ]}
                onChange={(value) => {
                  setOutputField(value);
                  setDirty(true);
                }}
              />
            </FieldGroup>
          )}
          {error && (
            <p className="app-form-error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
      {!secret && (
        <OverlayActions>
          <Button onClick={() => (dirty ? navigation.ask() : onClose())}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form="automation-editor" disabled={busy}>
            {t('common.save')}
          </Button>
        </OverlayActions>
      )}
      {navigation.asking && (
        <ConfirmDialog
          title={t('tables.record.discardTitle')}
          confirmLabel={t('tables.record.discard')}
          onConfirm={navigation.discard}
          onCancel={navigation.cancel}
        >
          {t('tables.record.discardBody')}
        </ConfirmDialog>
      )}
    </Overlay>
  );
}
function AutomationHistory({ rule, onClose }: { rule: Automation; onClose: () => void }) {
  const { t } = useI18n();
  const history = useInfiniteQuery({
    queryKey: ['tables', 'automation-runs', rule.id],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.tables.automations.history(rule.id, { cursor: pageParam }),
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    refetchInterval: 2000,
  });
  return (
    <Overlay title={t('tables.automation.history')} onClose={onClose}>
      <div className="app-stack">
        {history.isError && <ErrorBox>{tablesError(history.error, t)}</ErrorBox>}
        {history.data?.pages
          .flatMap((p) => p.items)
          .map((run) => (
            <div className="app-tb-automation" key={run.id}>
              <strong>{t(`tables.automation.status.${run.status}`)}</strong>
              <p className="app-muted">{new Date(run.created_at).toLocaleString()}</p>
              {run.run_id && (
                <Button size="sm" onClick={() => navigate({ page: 'run', id: run.run_id! })}>
                  {t('nav.runs')}
                </Button>
              )}
              {run.error && <p>{t('tables.automation.runFailed')}</p>}
            </div>
          ))}
        {history.data?.pages[0]?.items.length === 0 && <Empty title={t('tables.automation.noRuns')} />}
        {history.hasNextPage && <Button onClick={() => void history.fetchNextPage()}>{t('clients.more')}</Button>}
      </div>
    </Overlay>
  );
}
