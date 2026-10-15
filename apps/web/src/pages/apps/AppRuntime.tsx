import { ExtensionPanels } from '../../extensions/host';
import { useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Banner, Button, ConfirmDialog, ErrorBox, FieldGroup, Overlay, Skeleton, Tabs } from '@greenhouse/ui/kit';
import type {
  AppAction,
  AppCard,
  AppRuntime as Runtime,
  BaseTable,
  RecordDetail,
  RecordValues,
  TableRecord,
} from '@greenhouse/contract';
import { useSession } from '../../app/session';
import { useNotify } from '../../app/notify';
import { useAppRuntime } from '../../data/apps';
import { usePeople } from '../../data/people';
import { queryClient } from '../../data/query';
import { api } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { Page, PageHeader } from '../../shell/Page';
import { CellValue, FieldInput, fromText } from '../tables/cells';
import { CardBody } from '../tables/dashboards/CardBody';
import { titleOf, type CellLookups } from '../tables/model';
import { CustomCard } from './CustomCard';
import { appsError } from './errors';
import '../../styles/apps.css';
import '../../styles/tables.css';
import '../../styles/tables-dashboards.css';

export function AppRuntime({ id, pageId, previewRole }: { id: string; pageId?: string; previewRole?: string }) {
  const t = useT();
  const runtime = useAppRuntime(id, previewRole);
  if (!runtime.data)
    return (
      <Page header={<PageHeader title={t('nav.apps')} />}>
        {runtime.isPending ? (
          <Skeleton lines={6} />
        ) : (
          <ErrorBox onRetry={() => void runtime.refetch()}>{appsError(runtime.error, t)}</ErrorBox>
        )}
      </Page>
    );
  return <RuntimePages runtime={runtime.data} pageId={pageId} />;
}
function RuntimePages({ runtime, pageId }: { runtime: Runtime; pageId?: string }) {
  const t = useT();
  const [previewPage, setPreviewPage] = useState(pageId);
  const page = runtime.pages.find((p) => p.id === (runtime.preview ? previewPage : pageId)) ?? runtime.pages[0]!;
  return (
    <Page
      header={
        <PageHeader
          title={runtime.app.name}
          primary={
            runtime.app.editable && !runtime.preview ? (
              <Button onClick={() => navigate({ page: 'app-edit', id: runtime.app.id })}>{t('apps.build')}</Button>
            ) : undefined
          }
        />
      }
    >
      <ExtensionPanels entity="app" id={runtime.app.id} />
      {runtime.preview && <Banner>{t('apps.previewHint')}</Banner>}
      <Tabs
        items={runtime.pages.map((p) => p.name)}
        value={page.name}
        onChange={(name) =>
          runtime.preview
            ? setPreviewPage(runtime.pages.find((p) => p.name === name)!.id)
            : navigate({ page: 'app', id: runtime.app.id, appPage: runtime.pages.find((p) => p.name === name)!.id })
        }
      />
      <div className="app-ap-grid">
        {page.cards.map((card) => (
          <RuntimeCard key={`${runtime.version}:${card.id}`} runtime={runtime} card={card} />
        ))}
      </div>
    </Page>
  );
}
function RuntimeCard({ runtime, card }: { runtime: Runtime; card: AppCard }) {
  const t = useT();
  const notify = useNotify();
  const { me } = useSession();
  const { memberById } = usePeople();
  const query = useInfiniteQuery({
    queryKey: ['apps', runtime.app.id, 'card', runtime.version, card.id, runtime.preview_role],
    queryFn: ({ pageParam }) =>
      api.apps.card(runtime.app.id, runtime.version, card.id, pageParam, runtime.preview_role ?? undefined),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (p) => (p.kind === 'records' ? (p.data.next_cursor ?? undefined) : undefined),
    enabled: card.kind !== 'button' && card.kind !== 'form' && card.kind !== 'custom',
  });
  const [recordId, setRecordId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ action: AppAction; record?: TableRecord } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const table = 'table_id' in card ? runtime.base.tables.find((t) => t.id === card.table_id) : undefined;
  const answers = query.data?.pages;
  const recordPages = useMemo(() => answers?.flatMap((a) => (a.kind === 'records' ? [a.data] : [])) ?? [], [answers]);
  const lookups: CellLookups = useMemo(
    () => ({
      members: memberById,
      linked: Object.assign({}, ...recordPages.map((p) => p.linked)),
      files: Object.assign({}, ...recordPages.map((p) => p.files)),
      timeZone: me?.timezone ?? 'Asia/Shanghai',
    }),
    [memberById, recordPages, me?.timezone],
  );
  const execute = async () => {
    if (!confirm || busy) return;
    setBusy(true);
    setError('');
    try {
      await api.apps.execute(runtime.app.id, {
        version: runtime.version,
        card: card.id,
        action: confirm.action.id,
        record_id: confirm.record?.id,
        revision: confirm.record?.revision,
      });
      setConfirm(null);
      void queryClient.invalidateQueries({ queryKey: ['apps', runtime.app.id] });
      notify(t('common.saved'));
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  let body;
  if (card.kind === 'custom') body = <CustomCard runtime={runtime} card={card} />;
  else if (card.kind === 'external' && answers?.[0]?.kind === 'external') {
    const data = answers[0];
    body = (
      <div className="app-ap-table">
        <table>
          <thead>
            <tr>
              {data.columns.map((c, i) => (
                <th key={i}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.rows.map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td key={j}>{v === null ? '' : String(v)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  } else if (runtime.preview && (card.kind === 'form' || card.kind === 'button'))
    body = (
      <p className="app-muted">
        {'fields' in card
          ? card.fields.flatMap((id) => table?.fields.find((f) => f.id === id)?.name ?? []).join(' · ')
          : card.title}
      </p>
    );
  else if (card.kind === 'button')
    body = (
      <Button
        onClick={() => setConfirm({ action: card.action })}
        disabled={runtime.preview || !(table && table.access !== 'read' && runtime.base.access !== 'viewer')}
      >
        {card.action.name}
      </Button>
    );
  else if (card.kind === 'form')
    body = table ? <AppForm runtime={runtime} card={card} table={table} lookups={lookups} /> : null;
  else if (query.error) body = <ErrorBox onRetry={() => void query.refetch()}>{appsError(query.error, t)}</ErrorBox>;
  else if (query.isPending) body = <Skeleton lines={3} />;
  else if ('fields' in card && table) {
    const records = recordPages.flatMap((p) => p.items);
    const primary = table.fields.find((f) => f.is_primary);
    const fields = card.fields
      .flatMap((id) => table.fields.find((f) => f.id === id) ?? [])
      .filter((f) => !f.is_primary);
    const row = (record: TableRecord) => (
      <div key={record.id} className="app-ap-record">
        <Button kind="ghost" onClick={() => setRecordId(record.id)}>
          {titleOf(table.fields, record) || t('tables.record.untitled')}
        </Button>
        <div className="app-ap-values">
          {fields.map((field) => (
            <span key={field.id}>
              <span className="app-muted">{field.name}: </span>
              <CellValue field={field} value={record.values[field.id]} lookups={lookups} />
            </span>
          ))}
        </div>
        <div className="app-ap-actions">
          {card.actions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              disabled={runtime.preview || !(table.access !== 'read' && runtime.base.access !== 'viewer')}
              onClick={() => setConfirm({ action, record })}
            >
              {action.name}
            </Button>
          ))}
        </div>
      </div>
    );
    if (card.kind === 'table')
      body = (
        <div className="app-ap-table">
          <table>
            <thead>
              <tr>
                <th>{primary?.name}</th>
                {fields.map((f) => (
                  <th key={f.id}>{f.name}</th>
                ))}
                <th>{t('apps.action')}</th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.id}>
                  <td>
                    <Button kind="ghost" onClick={() => setRecordId(record.id)}>
                      {titleOf(table.fields, record) || t('tables.record.untitled')}
                    </Button>
                  </td>
                  {fields.map((field) => (
                    <td key={field.id}>
                      <CellValue field={field} value={record.values[field.id]} lookups={lookups} />
                    </td>
                  ))}
                  <td>
                    {card.actions.map((action) => (
                      <Button
                        key={action.id}
                        size="sm"
                        disabled={runtime.preview || !(table.access !== 'read' && runtime.base.access !== 'viewer')}
                        onClick={() => setConfirm({ action, record })}
                      >
                        {action.name}
                      </Button>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    else if (card.kind === 'kanban') {
      const field = table.fields.find((f) => f.id === card.group_field);
      const groups = [{ id: '', label: t('tables.record.untitled') }, ...(field?.config.options ?? [])];
      body = (
        <div className="app-ap-board">
          {groups.map((group) => (
            <section key={group.id}>
              <h3>{group.label}</h3>
              {records.filter((r) => String(r.values[field?.id ?? ''] ?? '') === group.id).map(row)}
            </section>
          ))}
        </div>
      );
    } else body = <div>{records.map(row)}</div>;
    if (!records.length) body = <p>{t('apps.noRecords')}</p>;
  } else {
    const data = answers?.[0];
    body = (
      <CardBody
        card={
          (card.kind === 'external'
            ? { id: card.id, title: card.title, kind: card.map.kind, table_id: '', measure: { aggregate: 'count' } }
            : card) as import('@greenhouse/contract').Card
        }
        data={data?.kind === 'chart' ? data.data : undefined}
        table={table}
        baseId={runtime.base.id}
        label={card.title}
      />
    );
  }
  return (
    <article className="app-ap-tile">
      <h2>{card.title}</h2>
      {body}
      {query.hasNextPage && (
        <Button loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {t('knowledge.showMore')}
        </Button>
      )}
      {error && <p role="alert">{error}</p>}
      {recordId && table && (
        <AppRecord
          runtime={runtime}
          card={card}
          table={table}
          id={recordId}
          onClose={() => setRecordId(null)}
          onAction={(action, record) => setConfirm({ action, record })}
        />
      )}
      {confirm && (
        <ConfirmDialog
          title={confirm.action.name}
          children={t('apps.actionHint')}
          confirmLabel={t('apps.execute')}
          onConfirm={() => void execute()}
          onCancel={() => setConfirm(null)}
        />
      )}
    </article>
  );
}
function AppRecord({
  runtime,
  card,
  table,
  id,
  onClose,
  onAction,
}: {
  runtime: Runtime;
  card: AppCard;
  table: BaseTable;
  id: string;
  onClose: () => void;
  onAction: (action: AppAction, record: TableRecord) => void;
}) {
  const t = useT();
  const { memberById } = usePeople();
  const { me } = useSession();
  const record = useQuery({
    queryKey: ['apps', runtime.app.id, 'record', runtime.version, card.id, id, runtime.preview_role],
    queryFn: () => api.apps.record(runtime.app.id, runtime.version, card.id, id, runtime.preview_role ?? undefined),
  });
  const lookups: CellLookups = {
    members: memberById,
    linked: record.data?.linked ?? {},
    files: record.data?.files ?? {},
    timeZone: me?.timezone ?? 'Asia/Shanghai',
  };
  const allowed = new Set('fields' in card ? (card.detail_fields ?? card.fields) : []);
  const fields = table.fields.filter((f) => allowed.has(f.id));
  return (
    <Overlay
      variant="drawer"
      title={record.data ? titleOf(table.fields, record.data.record) : t('tables.record.untitled')}
      onClose={onClose}
    >
      {record.isPending ? (
        <Skeleton lines={4} />
      ) : record.error ? (
        <ErrorBox onRetry={() => void record.refetch()}>{appsError(record.error, t)}</ErrorBox>
      ) : (
        <>
          <dl className="app-ap-detail">
            {fields.map((field) => (
              <div key={field.id}>
                <dt>{field.name}</dt>
                <dd>
                  <CellValue field={field} value={record.data!.record.values[field.id]} lookups={lookups} />
                </dd>
              </div>
            ))}
          </dl>
          {'actions' in card && (
            <div className="app-ap-actions">
              {card.actions.map((action) => (
                <Button
                  key={action.id}
                  disabled={runtime.preview || !(table.access !== 'read' && runtime.base.access !== 'viewer')}
                  onClick={() => onAction(action, record.data!.record)}
                >
                  {action.name}
                </Button>
              ))}
            </div>
          )}
        </>
      )}
    </Overlay>
  );
}
function AppForm({
  runtime,
  card,
  table,
  lookups,
}: {
  runtime: Runtime;
  card: Extract<AppCard, { fields: string[] }>;
  table: BaseTable;
  lookups: CellLookups;
}) {
  const t = useT();
  const [values, setValues] = useState<RecordValues>({});
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState<RecordDetail['files']>({});
  const fields = card.fields.flatMap((id) => table.fields.find((f) => f.id === id) ?? []);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await api.apps.execute(runtime.app.id, {
        version: runtime.version,
        card: card.id,
        action: 'submit',
        values: Object.fromEntries(
          fields.map((f) => [f.id, fromText(f, values[f.id])]).filter(([, v]) => v !== undefined),
        ),
      });
      setSent(true);
      void queryClient.invalidateQueries({ queryKey: ['apps', runtime.app.id] });
    } catch (e) {
      setError(appsError(e, t));
    } finally {
      setBusy(false);
    }
  };
  if (sent) return <p role="status">{t('apps.submitted')}</p>;
  return (
    <form
      className="app-form"
      aria-label={card.title}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {fields.map((field) => (
        <FieldGroup key={field.id} label={field.name}>
          <FieldInput
            field={field}
            baseId={runtime.base.id}
            value={values[field.id]}
            lookups={{ ...lookups, files: { ...lookups.files, ...files } }}
            onFiles={(added) =>
              setFiles((current) => ({ ...current, ...Object.fromEntries(added.map((f) => [f.id, f])) }))
            }
            onChange={(value) => setValues({ ...values, [field.id]: value })}
          />
        </FieldGroup>
      ))}
      {error && <p role="alert">{error}</p>}
      <Button
        kind="primary"
        type="submit"
        loading={busy}
        disabled={runtime.preview || !(table.access !== 'read' && runtime.base.access !== 'viewer')}
      >
        {t('apps.submit')}
      </Button>
    </form>
  );
}
