/**
 * A record of an app, opened from a card (`records/get`): the detail's fields
 * the role may read (shared `FieldValue`; attachments download through the
 * app), its declared actions the gateway offers now, an Edit for the detail's
 * editable fields (a centred dialog — the drawer stays a read context), and
 * the activity tab (the role-readable changes, comments when the detail and
 * the role allow them) — the Tables activity panel on the gateway's source.
 * `tables:records_changed` for this record re-reads it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppRecordView, AppRuntimeView } from '@greenhouse/types/apps';
import { TABLE_SYSTEM_FIELDS, type TableSystemField } from '@greenhouse/types/tables';
import {
  appRecordToTableRecord,
  appTableDefinition,
  appTableFields,
  brokenActionIds,
  drawerActions,
  offeredActions,
  pickFields,
  refsUsers,
  usersByIdOf,
  viewTable,
  AppRecordActionButtons,
  type AppRecordsLikeCard,
} from '../../../components/app-cards';
import { DetailHeader, DetailSection, Field, FieldGrid } from '../../../components/detail';
import { FieldValue, FieldValueRefsProvider, type FieldValueRefs } from '../../../components/tables/field-value';
import { SYSTEM_FIELD_LABEL_KEYS } from '../../../components/tables/field-types';
import { Button, Drawer, EmptyState, IconButton, Skeleton, Tabs, toast } from '../../../components/ui';
import { useTablesRecordsChanged } from '../../../hooks/use-tables-records-changed';
import {
  appFilePath,
  createAppComment,
  deleteAppComment,
  getAppRecord,
  listAppActivity,
  updateAppComment,
} from '../../../lib/api/apps';
import { TablesRequestError, type TableField, type TableRecord } from '../../../lib/api/tables';
import { downloadAuthenticatedFile } from '../../../lib/file-download';
import { useT } from '../../../lib/i18n';
import { Download, Edit3, Eye, Lock, Paperclip, X } from '../../../lib/icons';
import { formatDate } from '../../../lib/utils';
import { useAuthStore } from '../../../stores';
import { RecordActivityPanel, type RecordActivitySource } from '../../tables/record-drawer/activity-panel';

/** Which record, opened through which card (the gateway authorizes per card). */
export interface AppRecordTarget {
  pageId: string;
  card: AppRecordsLikeCard;
  recordId: number;
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; detail: AppRecordView }
  | { kind: 'missing' }
  | { kind: 'failed' };

interface AppRecordDrawerProps {
  appId: number;
  view: AppRuntimeView;
  target: AppRecordTarget | null;
  previewRole?: string;
  /** Bumped by the host after its own writes to this record (an action, an edit). */
  version: number;
  onClose: () => void;
  onRunAction: (target: AppRecordTarget, detail: AppRecordView, actionId: string) => void;
  onEdit: (target: AppRecordTarget, detail: AppRecordView) => void;
}

const FIELDS_TAB = 'fields';
const ACTIVITY_TAB = 'activity';

function AttachmentList({
  ids,
  detail,
  onDownload,
}: {
  ids: unknown;
  detail: AppRecordView;
  onDownload: (fileId: number, name: string) => void;
}) {
  const t = useT();
  const files = (Array.isArray(ids) ? ids : []).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  if (files.length === 0) return <span className="text-fg-faint">—</span>;
  return (
    <ul className="space-y-1">
      {files.map((fileId) => {
        const name = detail.refs.files[String(fileId)]?.name ?? t('apps.runtime.record.fileNumber', { id: fileId });
        return (
          <li key={fileId} className="flex min-w-0 items-center gap-1.5">
            <Paperclip size={12} className="flex-shrink-0 text-fg-faint" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate" title={name}>
              {name}
            </span>
            <IconButton
              size="compact"
              label={t('apps.runtime.record.download', { name })}
              onClick={() => onDownload(fileId, name)}
            >
              <Download size={13} />
            </IconButton>
          </li>
        );
      })}
    </ul>
  );
}

function systemValue(
  record: TableRecord,
  field: TableSystemField,
  usersById: ReadonlyMap<string, { nickname: string }>,
): string {
  if (field === 'created_by' || field === 'updated_by') {
    const id = record[field];
    return id ? (usersById.get(id)?.nickname ?? id) : '—';
  }
  return record[field] ? formatDate(record[field]) : '—';
}

function RecordContent({
  appId,
  view,
  target,
  detail,
  onClose,
  onRunAction,
  onEdit,
}: Omit<AppRecordDrawerProps, 'target' | 'version' | 'previewRole'> & {
  target: AppRecordTarget;
  detail: AppRecordView;
}) {
  const t = useT();
  const currentUserId = useAuthStore((state) => state.currentUser?.id ?? '');
  const [tab, setTab] = useState(FIELDS_TAB);
  const { card, pageId } = target;
  const table = viewTable(view, card.source.tableId);
  const fields = useMemo(() => appTableFields(table), [table]);
  const shown = useMemo(() => pickFields(fields, detail.fieldIds), [detail.fieldIds, fields]);
  const record = useMemo(
    () => appRecordToTableRecord(detail.record, card.source.tableId),
    [card.source.tableId, detail.record],
  );
  const users = useMemo(() => refsUsers(detail.refs), [detail.refs]);
  const usersById = useMemo(() => usersByIdOf(users), [users]);
  const primary = fields.find((field) => field.is_primary);
  const primaryValue = primary ? detail.record.values[String(primary.id)] : undefined;
  const actions = offeredActions(drawerActions(card), detail.record, brokenActionIds(view.issues, pageId, card.id));
  const labels = useMemo<FieldValueRefs>(
    () => ({
      records: detail.refs.records,
      files: detail.refs.files,
      restrictedLabel: t('apps.runtime.cards.restricted'),
    }),
    [detail.refs, t],
  );
  const systemFields = detail.systemFields.filter((field) => TABLE_SYSTEM_FIELDS.includes(field));

  const download = (field: TableField) => (fileId: number, name: string) =>
    void downloadAuthenticatedFile(
      appFilePath(appId, fileId, { pageId, cardId: card.id, recordId: record.id, fieldId: field.id }),
      name,
    ).catch(() => toast(t('apps.runtime.record.downloadFailed'), 'error'));

  const ref = { pageId, cardId: card.id, recordId: record.id };
  const source = useMemo<RecordActivitySource>(
    () => ({
      load: (cursor) => listAppActivity(appId, { ...ref, ...(cursor ? { cursor } : {}) }),
      create: (body) => createAppComment(appId, { ...ref, body }),
      update: (commentId, body) => updateAppComment(appId, commentId, { pageId, cardId: card.id, body }),
      remove: (commentId) => deleteAppComment(appId, commentId, { pageId, cardId: card.id }),
      viewer: { userId: currentUserId, canComment: detail.canComment, canModerate: false },
    }),
    // `ref` is derived from these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appId, card.id, currentUserId, detail.canComment, pageId, record.id],
  );

  return (
    <FieldValueRefsProvider value={labels}>
      <div className="flex h-full min-h-0 flex-col" data-testid="app-record-drawer">
        <div className="flex-shrink-0 space-y-3 border-b border-edge px-5 pb-3 pt-5">
          <DetailHeader
            icon={
              <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-primary-subtle text-primary-fg-strong">
                <Eye size={18} />
              </div>
            }
            title={
              primary && primaryValue !== undefined && primaryValue !== null && primaryValue !== '' ? (
                <FieldValue field={primary} value={primaryValue} usersById={usersById} />
              ) : (
                t('apps.runtime.record.title', { id: record.id })
              )
            }
            meta={<span>{table?.name}</span>}
            actions={
              <>
                {detail.editableFieldIds.length > 0 && (
                  <IconButton
                    label={t('apps.runtime.record.edit')}
                    tooltip="top"
                    tooltipMode="portal"
                    onClick={() => onEdit(target, detail)}
                    data-testid="app-record-edit"
                  >
                    <Edit3 size={15} />
                  </IconButton>
                )}
                <IconButton label={t('apps.runtime.record.close')} tooltip="top" tooltipMode="portal" onClick={onClose}>
                  <X size={15} />
                </IconButton>
              </>
            }
          />
          <AppRecordActionButtons
            actions={actions}
            onRun={(action) => onRunAction(target, detail, action.id)}
            testIdPrefix="app-record-action"
          />
          <Tabs
            tabs={[
              { key: FIELDS_TAB, label: t('apps.runtime.record.fields') },
              { key: ACTIVITY_TAB, label: t('apps.runtime.record.activity'), testId: 'app-record-activity-tab' },
            ]}
            active={tab}
            onChange={setTab}
            ariaLabel={t('apps.runtime.record.sections')}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tab === ACTIVITY_TAB && table ? (
            <RecordActivityPanel
              table={appTableDefinition(view, table)}
              record={record}
              fields={shown}
              users={users}
              usersById={usersById}
              canEdit={false}
              onRecordChanged={() => undefined}
              source={source}
            />
          ) : (
            <div className="space-y-6">
              <DetailSection title={t('apps.runtime.record.fields')}>
                <FieldGrid cols={2}>
                  {shown.map((field) => (
                    <Field key={field.id} label={field.name} span={field.type === 'long_text' ? 'full' : 1}>
                      {field.type === 'attachment' ? (
                        <AttachmentList
                          ids={detail.record.values[String(field.id)]}
                          detail={detail}
                          onDownload={download(field)}
                        />
                      ) : (
                        <FieldValue
                          field={field}
                          value={detail.record.values[String(field.id)]}
                          usersById={usersById}
                        />
                      )}
                    </Field>
                  ))}
                </FieldGrid>
              </DetailSection>
              {systemFields.length > 0 && (
                <DetailSection title={t('apps.runtime.record.details')}>
                  <FieldGrid cols={2}>
                    {systemFields.map((field) => (
                      <Field
                        key={field}
                        label={t(SYSTEM_FIELD_LABEL_KEYS[field])}
                        value={systemValue(record, field, usersById)}
                      />
                    ))}
                  </FieldGrid>
                </DetailSection>
              )}
            </div>
          )}
        </div>
      </div>
    </FieldValueRefsProvider>
  );
}

export function AppRecordDrawer(props: AppRecordDrawerProps) {
  const t = useT();
  const { appId, target, previewRole, version } = props;
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const key = target ? `${target.pageId}:${target.card.id}:${target.recordId}` : '';

  const load = useCallback(
    async (quiet = false) => {
      if (!target) return;
      if (!quiet) setState({ kind: 'loading' });
      try {
        const detail = await getAppRecord(appId, {
          pageId: target.pageId,
          cardId: target.card.id,
          recordId: target.recordId,
          ...(previewRole ? { previewRole } : {}),
        });
        setState({ kind: 'ready', detail });
      } catch (error) {
        setState(
          error instanceof TablesRequestError && error.status === 404 ? { kind: 'missing' } : { kind: 'failed' },
        );
      }
    },
    // Keyed by the record, not the target object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [appId, key, previewRole],
  );

  useEffect(() => {
    void load();
  }, [load]);
  // The host wrote to it (an action, an edit): re-read quietly.
  useEffect(() => {
    if (version > 0) void load(true);
  }, [load, version]);
  useTablesRecordsChanged(
    { tableId: target?.card.source.tableId, recordIds: target ? [target.recordId] : [] },
    () => load(true),
    { enabled: target !== null },
  );

  return (
    <Drawer
      open={target !== null}
      onClose={props.onClose}
      side="right"
      width="min(520px, calc(100vw - 2rem))"
      ariaLabel={target ? t('apps.runtime.record.title', { id: target.recordId }) : t('apps.runtime.record.details')}
    >
      {target && state.kind === 'ready' && <RecordContent key={key} {...props} target={target} detail={state.detail} />}
      {target && state.kind === 'loading' && (
        <div className="space-y-3 p-5" aria-busy="true">
          <Skeleton className="h-10 w-2/3" />
          <Skeleton className="h-24 w-full" />
        </div>
      )}
      {target && (state.kind === 'missing' || state.kind === 'failed') && (
        <div className="p-5">
          <EmptyState
            icon={Lock}
            variant="compact"
            tone={state.kind === 'missing' ? 'neutral' : 'danger'}
            title={state.kind === 'missing' ? t('apps.runtime.record.notFound') : t('apps.runtime.record.loadFailed')}
            action={
              <Button
                variant="outline"
                size="sm"
                onClick={state.kind === 'missing' ? props.onClose : () => void load()}
              >
                {state.kind === 'missing' ? t('apps.runtime.record.close') : t('common.retry')}
              </Button>
            }
          />
        </div>
      )}
    </Drawer>
  );
}
