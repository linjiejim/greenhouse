/**
 * One page of an app as its viewer uses it: the page's filter bar, its cards
 * on the shared widget grid (laid out from the spec, one column under 768px),
 * and everything the cards ask the host for — the record drawer, the action
 * confirmations and input dialogs, the create and edit forms. Every write goes
 * through the gateway's `/actions` with a request id; a stale revision is
 * replayed when it is safe (`runAppActionWithReplay`), refusals are said in
 * the viewer's words, and the cards reading the written table refresh.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AppActionResult,
  AppCard,
  AppPage,
  AppRecordAction,
  AppRecordRow,
  AppRuntimeView,
} from '@greenhouse/types/apps';
import type { TableFieldValueEntry, TableFilterControl } from '@greenhouse/types/tables';
import {
  actionInputFieldIds,
  AppCardView,
  appTableFields,
  cardIssue,
  drawerActions,
  isQueriedCard,
  isRecordsLikeCard,
  pickFields,
  viewTable,
  type AppCardHost,
  type AppRecordsLikeCard,
} from '../../../components/app-cards';
import { FilterBar, type TableCardFilterValues } from '../../../components/table-cards';
import { ConfirmDialog, EmptyState, toast } from '../../../components/ui';
import { WidgetGrid, type WidgetGridItem } from '../../../components/workbench/widget-grid';
import {
  appFilePath,
  getAppRecord,
  listAppFieldOptions,
  newAppRequestId,
  runAppAction,
  runAppActionWithReplay,
  uploadAppFile,
} from '../../../lib/api/apps';
import type { TableField } from '../../../lib/api/tables';
import { useT } from '../../../lib/i18n';
import { LayoutGrid } from '../../../lib/icons';
import { describeAppError } from './errors';
import { describeFilters } from './filter-context';
import { AppFormDialog, type AppFormRequest } from './form-dialog';
import { AppRecordDrawer, type AppRecordTarget } from './record-drawer';
import { useAppPageCards } from './use-app-page-cards';

/** The spec's layouts are written against twelve columns, like dashboards. */
const APP_GRID_COLUMNS = 12;

/** Smallest usable size per kind; stored layouts are drawn as they are, only clamped up to this. */
const MIN_SIZE: Record<AppCard['kind'], { w: number; h: number; mobileH: number }> = {
  records: { w: 4, h: 4, mobileH: 8 },
  kanban: { w: 4, h: 5, mobileH: 9 },
  calendar: { w: 4, h: 6, mobileH: 10 },
  gallery: { w: 4, h: 5, mobileH: 9 },
  form: { w: 4, h: 4, mobileH: 8 },
  kpi: { w: 2, h: 2, mobileH: 3 },
  chart: { w: 4, h: 4, mobileH: 6 },
  pivot: { w: 4, h: 4, mobileH: 6 },
  text: { w: 2, h: 1, mobileH: 2 },
  buttons: { w: 2, h: 1, mobileH: 2 },
};

export function gridItems(cards: readonly AppCard[]): WidgetGridItem[] {
  return cards.map((card) => {
    const min = MIN_SIZE[card.kind];
    const w = Math.min(Math.max(card.layout.w || min.w, min.w), APP_GRID_COLUMNS);
    const h = Math.max(card.layout.h || min.h, min.h);
    return {
      id: card.id,
      x: Math.min(Math.max(card.layout.x, 0), APP_GRID_COLUMNS - w),
      y: Math.max(card.layout.y, 0),
      w,
      h,
      minW: min.w,
      minH: min.h,
      mobileH: Math.max(h, min.mobileH),
    };
  });
}

/** Controls whose targets the role can still read (the server ignores the rest anyway). */
function visibleControls(controls: readonly TableFilterControl[] | undefined, view: AppRuntimeView) {
  const readable = new Set(view.tables.flatMap((table) => table.fields.map((field) => `${table.id}:${field.id}`)));
  return (controls ?? []).filter((control) =>
    control.targets.some((target) => target.systemField || readable.has(`${target.tableId}:${target.fieldId}`)),
  );
}

interface PendingConfirm {
  title: string;
  description: string;
  destructive: boolean;
  confirmLabel: string;
  run: () => Promise<void>;
}

export interface AppPageViewProps {
  view: AppRuntimeView;
  page: AppPage;
  previewRole?: string;
  /** `?record=<id>` (optionally `&card=<cardId>`): open that record once, then `onDeepLinkHandled`. */
  deepLink?: { recordId: number; cardId?: string };
  onDeepLinkHandled: () => void;
  onOpenPage: (pageId: string) => void;
  /** The filters on screen as the bar shows them, for the Assistant (`Status: Pending`). */
  onFiltersChange?: (filters: Array<{ label: string; value: string }>) => void;
}

export function AppPageView({
  view,
  page,
  previewRole,
  deepLink,
  onDeepLinkHandled,
  onOpenPage,
  onFiltersChange,
}: AppPageViewProps) {
  const t = useT();
  const appId = view.app.id;
  const [filterValues, setFilterValues] = useState<TableCardFilterValues>({});
  const cards = useAppPageCards({ appId, view, page, previewRole, filterValues });
  const [drawer, setDrawer] = useState<AppRecordTarget | null>(null);
  const [drawerVersion, setDrawerVersion] = useState(0);
  const [form, setForm] = useState<AppFormRequest | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  const [confirming, setConfirming] = useState(false);
  /** Actions in flight per record: a second press of the same button waits for the first. */
  const running = useRef(new Set<string>());
  const controls = useMemo(() => visibleControls(page.filters, view), [page.filters, view]);
  const fieldsByTable = useMemo(
    () => new Map(view.tables.map((table) => [table.id, appTableFields(table)])),
    [view.tables],
  );
  const preview = previewRole ? { previewRole } : {};

  const described = useMemo(
    () => describeFilters(controls, filterValues, fieldsByTable, cards.users, t),
    [cards.users, controls, fieldsByTable, filterValues, t],
  );
  const describedKey = JSON.stringify(described);
  useEffect(() => {
    onFiltersChange?.(JSON.parse(describedKey) as Array<{ label: string; value: string }>);
  }, [describedKey, onFiltersChange]);

  const describe = useCallback((error: unknown) => describeAppError(t, error), [t]);

  const tableFields = useCallback((tableId: number): TableField[] => appTableFields(viewTable(view, tableId)), [view]);

  const afterWrite = useCallback(
    (tableId: number | undefined, result?: AppActionResult) => {
      void cards.refreshTable(tableId);
      setDrawerVersion((value) => value + 1);
      if (result?.outcome === 'deleted') setDrawer(null);
    },
    [cards],
  );

  const doneMessage = useCallback(
    (label: string, result: AppActionResult) =>
      result.outcome === 'queued'
        ? t('apps.runtime.actions.queued', { label })
        : result.outcome === 'deleted'
          ? t('apps.runtime.actions.deleted')
          : t('apps.runtime.actions.done', { label }),
    [t],
  );

  const execute = useCallback(
    async (
      card: AppRecordsLikeCard,
      action: AppRecordAction,
      row: Pick<AppRecordRow, 'id' | 'revision' | 'values'>,
      values: TableFieldValueEntry[] | undefined,
      requestId: string,
    ) => {
      try {
        const result = await runAppActionWithReplay(
          appId,
          {
            pageId: page.id,
            cardId: card.id,
            actionId: action.id,
            recordId: row.id,
            revision: row.revision,
            ...(values && values.length > 0 ? { values } : {}),
            requestId,
            ...preview,
          },
          row,
        );
        toast(doneMessage(action.label, result), 'success');
        afterWrite(card.source.tableId, result);
      } catch (error) {
        // What is on screen is probably stale (a precondition or a conflict): show the current state.
        afterWrite(card.source.tableId);
        throw error;
      }
    },
    // `preview` is derived from `previewRole`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [afterWrite, appId, doneMessage, page.id, previewRole],
  );

  const optionsFor = useCallback(
    (cardId: string, buttonId?: string) => (fieldId: number) =>
      listAppFieldOptions(appId, { pageId: page.id, cardId, fieldId, ...(buttonId ? { buttonId } : {}) }),
    [appId, page.id],
  );
  const uploadFor = useCallback(
    (cardId: string) => (fieldId: number, file: File) =>
      uploadAppFile(appId, { pageId: page.id, cardId, fieldId, file }),
    [appId, page.id],
  );

  const runAction = useCallback(
    (card: AppRecordsLikeCard, action: AppRecordAction, row: Pick<AppRecordRow, 'id' | 'revision' | 'values'>) => {
      const key = `${card.id}:${row.id}:${action.id}`;
      if (running.current.has(key)) return;
      const inputs = actionInputFieldIds(action);
      if (inputs.length > 0 && action.do.type === 'set_fields') {
        const requestId = newAppRequestId();
        setForm({
          title: action.label,
          fields: pickFields(tableFields(card.source.tableId), inputs),
          requiredFieldIds: new Set(action.do.requiredInputFieldIds ?? []),
          mode: 'create',
          submitLabel: action.label,
          intro: action.confirm,
          loadOptions: optionsFor(card.id),
          upload: uploadFor(card.id),
          onSubmit: (values) => execute(card, action, row, values, requestId),
          testId: 'app-action-dialog',
        });
        return;
      }
      const go = async () => {
        running.current.add(key);
        try {
          await execute(card, action, row, undefined, newAppRequestId());
        } catch (error) {
          toast(describe(error), 'error');
        } finally {
          running.current.delete(key);
        }
      };
      if (action.confirm || action.do.type === 'delete') {
        setConfirm({
          title: action.label,
          description: action.confirm ?? t('apps.runtime.actions.confirmDelete'),
          destructive: action.do.type === 'delete',
          confirmLabel: action.label,
          run: go,
        });
        return;
      }
      void go();
    },
    [describe, execute, optionsFor, t, tableFields, uploadFor],
  );

  const openCreate = useCallback(
    (card: AppCard, buttonId?: string) => {
      const button =
        card.kind === 'buttons'
          ? card.buttons.find((entry) => entry.id === buttonId && entry.type === 'create_record')
          : undefined;
      const spec =
        card.kind === 'records' && card.create
          ? { tableId: card.source.tableId, fieldIds: card.create.fieldIds, label: card.title }
          : button?.type === 'create_record'
            ? { tableId: button.tableId, fieldIds: button.fieldIds, label: button.label }
            : undefined;
      if (!spec) return;
      const requestId = newAppRequestId();
      const table = viewTable(view, spec.tableId);
      setForm({
        title: button
          ? button.label
          : t('apps.runtime.actions.createTitle', { table: table?.name ?? spec.label ?? '' }),
        fields: pickFields(tableFields(spec.tableId), spec.fieldIds),
        mode: 'create',
        submitLabel: t('apps.runtime.actions.create'),
        loadOptions: optionsFor(card.id, button?.id),
        upload: uploadFor(card.id),
        onSubmit: async (values) => {
          await runAppAction(appId, {
            pageId: page.id,
            cardId: card.id,
            actionId: '$create',
            values,
            requestId,
            ...(button ? { buttonId: button.id } : {}),
            ...preview,
          });
          toast(t('apps.runtime.actions.created'), 'success');
          afterWrite(spec.tableId);
        },
        testId: 'app-create-dialog',
      });
    },
    // `preview` is derived from `previewRole`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [afterWrite, appId, optionsFor, page.id, previewRole, t, tableFields, uploadFor, view],
  );

  const host = useMemo<AppCardHost>(
    () => ({
      appId,
      pageId: page.id,
      view,
      previewRole,
      users: cards.users,
      setParams: cards.setParams,
      retry: cards.retry,
      openRecord: (card, row) => {
        if (card.detail) setDrawer({ pageId: page.id, card, recordId: row.id });
      },
      runAction,
      openCreate,
      submitForm: async (card, values) => {
        await runAppAction(appId, {
          pageId: page.id,
          cardId: card.id,
          actionId: '$submit',
          values,
          requestId: newAppRequestId(),
          ...(previewRole ? { previewRole } : {}),
        });
        void cards.refreshTable(card.tableId);
      },
      move: async (card, row, fieldId, value) => {
        try {
          await runAppActionWithReplay(
            appId,
            {
              pageId: page.id,
              cardId: card.id,
              actionId: '$move',
              recordId: row.id,
              revision: row.revision,
              values: [{ fieldId, value }],
              requestId: newAppRequestId(),
              ...(previewRole ? { previewRole } : {}),
            },
            row,
          );
        } catch (error) {
          void cards.refreshTable(card.source.tableId);
          throw new Error(describe(error));
        }
        // The card keeps its new lane until the board shows the stored state.
        await cards.refreshTable(card.source.tableId);
      },
      openPage: onOpenPage,
      fileUrl: (card, recordId, fieldId, fileId) =>
        appFilePath(appId, fileId, { pageId: page.id, cardId: card.id, recordId, fieldId }),
      upload: (card, fieldId, file) => uploadAppFile(appId, { pageId: page.id, cardId: card.id, fieldId, file }),
      loadOptions: (card, fieldId, buttonId) => optionsFor(card.id, buttonId)(fieldId),
      describeError: describe,
    }),
    [appId, cards, describe, onOpenPage, openCreate, optionsFor, page.id, previewRole, runAction, view],
  );

  // A link to one record (a notification, `?record=`): find the card that may show it. Once per
  // link — later renders (cards loading) must not cancel the search; only leaving the page does.
  const linkKey = deepLink ? `${deepLink.recordId}:${deepLink.cardId ?? ''}` : '';
  const latest = useRef({ appId, page, view, previewRole, onDeepLinkHandled, t });
  latest.current = { appId, page, view, previewRole, onDeepLinkHandled, t };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!linkKey) return;
    const [recordPart, cardPart] = linkKey.split(':');
    const recordId = Number(recordPart);
    const { appId: app, page: here, view: current, previewRole: role } = latest.current;
    const candidates = [here, ...current.spec.pages.filter((entry) => entry.id !== here.id)].flatMap((entry) =>
      entry.cards
        .filter(isRecordsLikeCard)
        .filter((card) => card.detail && !cardIssue(current.issues, entry.id, card.id))
        .filter((card) => !cardPart || card.id === cardPart)
        .map((card) => ({ pageId: entry.id, card })),
    );
    void (async () => {
      for (const candidate of candidates) {
        const found = await getAppRecord(app, {
          pageId: candidate.pageId,
          cardId: candidate.card.id,
          recordId,
          ...(role ? { previewRole: role } : {}),
        }).catch(() => null);
        if (!mounted.current) return;
        if (found) {
          setDrawer({ pageId: candidate.pageId, card: candidate.card, recordId });
          latest.current.onDeepLinkHandled();
          return;
        }
      }
      if (!mounted.current) return;
      toast(latest.current.t('apps.runtime.record.linkUnavailable'), 'error');
      latest.current.onDeepLinkHandled();
    })();
  }, [linkKey]);

  const items = useMemo(() => gridItems(page.cards), [page.cards]);
  const cardsById = useMemo(() => new Map(page.cards.map((card) => [card.id, card])), [page.cards]);
  const queried = page.cards.filter(isQueriedCard);
  const allWithheld =
    queried.length > 0 &&
    queried.every((card) => cards.states[card.id]?.result?.kind === 'no_access') &&
    queried.length === page.cards.length;

  return (
    <div className="space-y-4" data-testid={`app-page-${page.id}`}>
      {controls.length > 0 && (
        <div className="rounded-xl border border-edge bg-surface-raised px-3 py-2.5 sm:px-4">
          <FilterBar
            controls={controls}
            values={filterValues}
            onChange={setFilterValues}
            fieldsByTable={fieldsByTable}
            users={cards.users}
          />
        </div>
      )}
      {allWithheld && view.app.canManage && (
        <p className="rounded-md border border-warning bg-warning-subtle px-4 py-2 text-xs text-warning" role="status">
          {t('apps.runtime.allNoAccess')}
        </p>
      )}
      {page.cards.length === 0 ? (
        <EmptyState icon={LayoutGrid} tone="neutral" title={t('apps.runtime.emptyPage')} />
      ) : (
        <WidgetGrid
          items={items}
          columns={APP_GRID_COLUMNS}
          renderItem={(id) => {
            const card = cardsById.get(id);
            return card ? <AppCardView card={card} host={host} state={cards.states[card.id]} /> : null;
          }}
        />
      )}

      <AppRecordDrawer
        appId={appId}
        view={view}
        target={drawer}
        previewRole={previewRole}
        version={drawerVersion}
        onClose={() => setDrawer(null)}
        onRunAction={(target, detail, actionId) => {
          const action = drawerActions(target.card).find((entry) => entry.id === actionId);
          if (action) runAction(target.card, action, detail.record);
        }}
        onEdit={(target, detail) => {
          const requestId = newAppRequestId();
          setForm({
            title: t('apps.runtime.record.editTitle', { id: detail.record.id }),
            fields: pickFields(tableFields(target.card.source.tableId), detail.editableFieldIds),
            initialValues: detail.record.values,
            mode: 'update',
            submitLabel: t('apps.runtime.record.save'),
            loadOptions: optionsFor(target.card.id),
            upload: uploadFor(target.card.id),
            onSubmit: async (values) => {
              if (values.length === 0) return;
              await runAppActionWithReplay(
                appId,
                {
                  pageId: target.pageId,
                  cardId: target.card.id,
                  actionId: '$edit',
                  recordId: detail.record.id,
                  revision: detail.record.revision,
                  values,
                  requestId,
                  ...(previewRole ? { previewRole } : {}),
                },
                detail.record,
              );
              toast(t('apps.runtime.record.saved'), 'success');
              afterWrite(target.card.source.tableId);
            },
            testId: 'app-edit-dialog',
          });
        }}
      />
      <AppFormDialog request={form} onClose={() => setForm(null)} describeError={describe} />
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          setConfirming(true);
          void confirm.run().finally(() => {
            setConfirming(false);
            setConfirm(null);
          });
        }}
        busy={confirming}
        title={confirm?.title ?? ''}
        description={confirm?.description ?? ''}
        confirmLabel={confirm?.confirmLabel ?? t('common.confirm')}
        confirmVariant={confirm?.destructive ? 'destructive' : 'default'}
      />
    </div>
  );
}
