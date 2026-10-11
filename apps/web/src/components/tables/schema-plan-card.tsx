/**
 * SchemaPlanCard — the body artifact behind the `tables_schema_plan` tool.
 *
 * The card IS the confirm gate: the tool wrote nothing, so until the user
 * presses Confirm no Base, table, view, form, automation, dashboard, role or
 * grant exists. Confirm posts the plan to /api/tables/schema-plan/apply with
 * the user's own session, and the server re-authorizes every operation — so a
 * tampered plan can never do more than its sender could already do by hand.
 *
 * Permission changes (grants, the team role, custom role rules, form
 * audiences) are derived by the server when the plan is drafted and shown in
 * their own highlighted section above the operations, so they are read before
 * Confirm rather than found among fifty lines.
 *
 * Schema operations are inherently non-idempotent, so the card derives a stable
 * message-position action id. The server atomically claims it before applying
 * anything and persists the exact result (with the ref → id map); refresh
 * restores that receipt instead of re-arming Confirm, and "retry unfinished
 * operations" re-runs only what did not apply.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { TABLE_CARD_KINDS, type TableCardKind } from '@greenhouse/types/table-cards';
import type {
  SchemaPlanAccessChange,
  SchemaPlanAccessLevel,
  SchemaPlanAppAudienceView,
  SchemaPlanApplyResult,
  SchemaPlanAudienceView,
  SchemaPlanOperation,
  SchemaPlanOperationResult,
  SchemaPlanRuleSummary,
  TablesSchemaPlanArtifact,
} from '@greenhouse/types/tables';
import { Columns3, Check, X, Minus, ShieldAlert } from '../../lib/icons';
import { Button, toast } from '../ui';
import { useT } from '../../lib/i18n';
import { applyTableSchemaPlan } from '../../lib/api/tables';
import { TRIGGER_LABEL_KEYS } from '../../pages/tables/automations/rule-draft';
import { TABLE_VIEW_TYPE_LABEL_KEYS } from '../../pages/tables/views/view-type-meta';
import { FIELD_TYPE_LABEL_KEYS } from './field-types';
import { useArtifactReceipt } from '../../hooks/use-artifact-receipt';
import { appBuilderHref } from '../../lib/app-routes';
import { ArtifactCard, ArtifactCardActions } from '../chat/artifact-card';

export type { TablesSchemaPlanArtifact };

type T = ReturnType<typeof useT>;
type OperationKind = SchemaPlanOperation['op'];

const OP_LABEL_KEYS = {
  'base.create': 'tablesSchemaPlan.opBaseCreate',
  'base.update': 'tablesSchemaPlan.opBaseUpdate',
  'table.create': 'tablesSchemaPlan.opTableCreate',
  'table.update': 'tablesSchemaPlan.opTableUpdate',
  'field.create': 'tablesSchemaPlan.opFieldCreate',
  'field.update': 'tablesSchemaPlan.opFieldUpdate',
  'field.archive': 'tablesSchemaPlan.opFieldArchive',
  'view.create': 'tablesSchemaPlan.opViewCreate',
  'view.update': 'tablesSchemaPlan.opViewUpdate',
  'form.create': 'tablesSchemaPlan.opFormCreate',
  'form.update': 'tablesSchemaPlan.opFormUpdate',
  'automation.create': 'tablesSchemaPlan.opAutomationCreate',
  'automation.update': 'tablesSchemaPlan.opAutomationUpdate',
  'dashboard.create': 'tablesSchemaPlan.opDashboardCreate',
  'dashboard.update': 'tablesSchemaPlan.opDashboardUpdate',
  'widget.create': 'tablesSchemaPlan.opWidgetCreate',
  'widget.update': 'tablesSchemaPlan.opWidgetUpdate',
  'widget.delete': 'tablesSchemaPlan.opWidgetDelete',
  'role.create': 'tablesSchemaPlan.opRoleCreate',
  'role.update': 'tablesSchemaPlan.opRoleUpdate',
  'member.set': 'tablesSchemaPlan.opMemberSet',
  'app.create': 'apps.agent.plan.opAppCreate',
  'app.update': 'apps.agent.plan.opAppUpdate',
  'app.audience': 'apps.agent.plan.opAppAudience',
  'app.publish': 'apps.agent.plan.opAppPublish',
} as const satisfies Record<OperationKind, string>;

type OperationGroup = 'structure' | 'fields' | 'views' | 'forms' | 'automations' | 'dashboards' | 'access' | 'apps';

const GROUP_ORDER: readonly OperationGroup[] = [
  'structure',
  'fields',
  'views',
  'forms',
  'automations',
  'dashboards',
  'access',
  'apps',
];

const GROUP_LABEL_KEYS = {
  structure: 'tablesSchemaPlan.groupStructure',
  fields: 'tablesSchemaPlan.groupFields',
  views: 'tablesSchemaPlan.groupViews',
  forms: 'tablesSchemaPlan.groupForms',
  automations: 'tablesSchemaPlan.groupAutomations',
  dashboards: 'tablesSchemaPlan.groupDashboards',
  access: 'tablesSchemaPlan.groupAccess',
  apps: 'apps.agent.plan.groupApps',
} as const satisfies Record<OperationGroup, string>;

const OP_GROUP = {
  'base.create': 'structure',
  'base.update': 'structure',
  'table.create': 'structure',
  'table.update': 'structure',
  'field.create': 'fields',
  'field.update': 'fields',
  'field.archive': 'fields',
  'view.create': 'views',
  'view.update': 'views',
  'form.create': 'forms',
  'form.update': 'forms',
  'automation.create': 'automations',
  'automation.update': 'automations',
  'dashboard.create': 'dashboards',
  'dashboard.update': 'dashboards',
  'widget.create': 'dashboards',
  'widget.update': 'dashboards',
  'widget.delete': 'dashboards',
  'role.create': 'access',
  'role.update': 'access',
  'member.set': 'access',
  'app.create': 'apps',
  'app.update': 'apps',
  'app.audience': 'apps',
  'app.publish': 'apps',
} as const satisfies Record<OperationKind, OperationGroup>;

/**
 * What the operation is about, in the user's words: the name it sets, else the
 * existing object's current name (`targetNames`, from the server's draft) —
 * an id only when neither is known.
 */
function operationTarget(operation: SchemaPlanOperation, current: string | undefined): string {
  switch (operation.op) {
    case 'base.create':
    case 'table.create':
    case 'field.create':
    case 'view.create':
    case 'form.create':
    case 'automation.create':
    case 'dashboard.create':
    case 'role.create':
    case 'app.create':
      return operation.name;
    case 'widget.create':
      return operation.title;
    case 'base.update':
      return operation.name ?? current ?? `#${operation.baseId ?? operation.baseRef}`;
    case 'table.update':
      return operation.name ?? current ?? `#${operation.tableId}`;
    case 'field.update':
      return operation.name ?? current ?? `#${operation.fieldId}`;
    case 'field.archive':
      return current ?? `#${operation.fieldId}`;
    case 'view.update':
      return operation.name ?? current ?? `#${operation.viewId}`;
    case 'form.update':
      return operation.name ?? current ?? `#${operation.formId}`;
    case 'automation.update':
      return operation.name ?? current ?? `#${operation.automationId}`;
    case 'dashboard.update':
      return operation.name ?? current ?? `#${operation.dashboardId}`;
    case 'widget.update':
      return operation.title ?? current ?? `#${operation.widgetId}`;
    case 'widget.delete':
      return current ?? `#${operation.widgetId}`;
    case 'role.update':
      return operation.name ?? current ?? `#${operation.roleId}`;
    case 'member.set':
      return current ?? (operation.principal === 'group' ? `#${operation.groupId}` : (operation.userId ?? ''));
    case 'app.update':
      return operation.name ?? current ?? `#${operation.appId ?? operation.appRef}`;
    case 'app.audience':
    case 'app.publish':
      return current ?? `#${operation.appId ?? operation.appRef}`;
  }
}

const isCardKind = (kind: unknown): kind is TableCardKind =>
  typeof kind === 'string' && (TABLE_CARD_KINDS as readonly string[]).includes(kind);

/** The one technical detail worth a glance (a type, a trigger), shown faint after the target — in words. */
function operationDetail(operation: SchemaPlanOperation, t: T): string | undefined {
  switch (operation.op) {
    case 'field.create': {
      const key = FIELD_TYPE_LABEL_KEYS[operation.type];
      return `${key ? t(key) : operation.type}${operation.required ? ` · ${t('tablesSchemaPlan.required')}` : ''}`;
    }
    case 'view.create':
      return t(TABLE_VIEW_TYPE_LABEL_KEYS[operation.type ?? 'grid']);
    case 'automation.create':
      return t(TRIGGER_LABEL_KEYS[operation.trigger]);
    case 'widget.create':
      return isCardKind(operation.card.kind) ? t(`tables.dashboard.editor.kind.${operation.card.kind}`) : undefined;
    case 'app.create': {
      const pages = Array.isArray(operation.spec.pages) ? operation.spec.pages.length : 0;
      const roles = Array.isArray(operation.spec.roles) ? operation.spec.roles.length : 0;
      return t('apps.agent.plan.appShape', { pages, roles });
    }
    default:
      return undefined;
  }
}

function levelLabel(level: SchemaPlanAccessLevel, t: T): string {
  if (level.kind === 'none') return t('tablesSchemaPlan.levelNone');
  if (level.kind === 'custom') return t('tablesSchemaPlan.levelCustom', { name: level.roleName });
  const keys = {
    owner: 'tablesSchemaPlan.levelOwner',
    builder: 'tablesSchemaPlan.levelBuilder',
    editor: 'tablesSchemaPlan.levelEditor',
    viewer: 'tablesSchemaPlan.levelViewer',
  } as const;
  return t(keys[level.role]);
}

function audienceLabel(audience: SchemaPlanAudienceView | null, t: T): string {
  if (!audience) return t('tablesSchemaPlan.audienceNew');
  if (audience.kind === 'base') return t('tablesSchemaPlan.audienceBase');
  if (audience.kind === 'team') return t('tablesSchemaPlan.audienceTeam');
  return t('tablesSchemaPlan.audiencePrincipals', { names: audience.names.join(', ') });
}

function rulesLabel(summary: SchemaPlanRuleSummary | null, t: T): string {
  if (!summary) return t('tablesSchemaPlan.ruleNew');
  const tables = summary.tables.map((rule) =>
    t('tablesSchemaPlan.ruleTable', {
      table: rule.table,
      access: [
        t(rule.access === 'edit' ? 'tablesSchemaPlan.ruleEdit' : 'tablesSchemaPlan.ruleRead'),
        ...(rule.limitedRows ? [t('tablesSchemaPlan.ruleLimitedRows')] : []),
        ...(rule.hiddenFields === 1
          ? [t('tablesSchemaPlan.ruleHiddenField')]
          : rule.hiddenFields > 1
            ? [t('tablesSchemaPlan.ruleHiddenFields', { count: rule.hiddenFields })]
            : []),
      ].join(', '),
    }),
  );
  const parts = tables.length > 0 ? tables : [t('tablesSchemaPlan.ruleNoTables')];
  return [...parts, ...(summary.dashboards ? [t('tablesSchemaPlan.ruleDashboards')] : [])].join('; ');
}

function appAudienceEntry(entry: SchemaPlanAppAudienceView, t: T): string {
  const who =
    entry.principal === 'team'
      ? t('apps.agent.plan.audienceTeam')
      : entry.principal === 'group'
        ? entry.managedBy
          ? t('apps.agent.plan.audienceGroupManaged', { name: entry.name, manager: entry.managedBy })
          : t('apps.agent.plan.audienceGroup', { name: entry.name })
        : entry.name;
  return t('apps.agent.plan.audienceEntry', { who, role: entry.role });
}

function appAudienceLabel(entries: SchemaPlanAppAudienceView[] | null, t: T): string {
  return entries && entries.length > 0
    ? entries.map((entry) => appAudienceEntry(entry, t)).join('; ')
    : t('apps.agent.plan.audienceNobody');
}

/** Subject, before and after of one access change, in the user's language. */
function describeChange(change: SchemaPlanAccessChange, t: T): { subject: string; before: string; after: string } {
  switch (change.kind) {
    case 'grant':
      return {
        subject: t(
          change.principal === 'group' ? 'tablesSchemaPlan.accessGrantGroup' : 'tablesSchemaPlan.accessGrantUser',
          { name: change.name, base: change.base },
        ),
        before: levelLabel(change.before, t),
        after: levelLabel(change.after, t),
      };
    case 'team':
      return {
        subject: t('tablesSchemaPlan.accessTeam', { base: change.base }),
        before: levelLabel(change.before, t),
        after: levelLabel(change.after, t),
      };
    case 'role':
      return {
        subject: t('tablesSchemaPlan.accessRole', { role: change.role }),
        before: rulesLabel(change.before, t),
        after: rulesLabel(change.after, t),
      };
    case 'form':
      return {
        subject: t('tablesSchemaPlan.accessForm', { form: change.form }),
        before: audienceLabel(change.before, t),
        after: `${audienceLabel(change.after, t)} · ${t(
          change.published ? 'tablesSchemaPlan.formPublished' : 'tablesSchemaPlan.formDraft',
        )}`,
      };
    case 'app_audience':
      return {
        subject: t('apps.agent.plan.accessAudience', { app: change.app }),
        before: appAudienceLabel(change.before, t),
        after: appAudienceLabel(change.after, t),
      };
    case 'app_publish':
      return {
        subject: t('apps.agent.plan.accessPublish', { app: change.app }),
        before:
          change.version > 1
            ? t('apps.agent.plan.publishLive', { version: change.version - 1 })
            : t('apps.agent.plan.publishFirst'),
        after: t('apps.agent.plan.publishAfter', {
          version: change.version,
          audience: appAudienceLabel(change.audience, t),
        }),
      };
  }
}

/**
 * The permission and outbound section of a plan, already in words — the chat
 * card words its artifact here; the Bots card (`components/bots/tables-plan-card.tsx`)
 * gets the lines from the server, which wrote them for every client.
 */
export function AccessChangeList({ lines }: { lines: Array<{ subject: string; before: string; after: string }> }) {
  const t = useT();
  return (
    <div
      className="rounded-md border border-warning/40 bg-warning-subtle px-2.5 py-2"
      data-testid="schema-plan-access-changes"
    >
      <p className="flex items-center gap-1.5 text-[11px] font-semibold text-warning">
        <ShieldAlert size={12} className="flex-shrink-0" />
        {t('tablesSchemaPlan.accessTitle')}
      </p>
      <p className="mt-0.5 text-[10px] text-fg-muted">{t('tablesSchemaPlan.accessHint')}</p>
      <ul className="mt-1.5 space-y-1">
        {lines.map(({ subject, before, after }, position) => (
          <li key={`${position}:${subject}`} className="text-xs leading-snug">
            <span className="font-medium text-fg">{subject}</span>
            <span className="text-fg-muted">
              {': '}
              {before}
              {' → '}
            </span>
            <span className="font-medium text-fg">{after}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function AccessChanges({ changes }: { changes: SchemaPlanAccessChange[] }) {
  const t = useT();
  return <AccessChangeList lines={changes.map((change) => describeChange(change, t))} />;
}

/** How one operation came out (the Bots card shows the same marks). */
export function StatusIcon({ status }: { status: SchemaPlanOperationResult['status'] }) {
  if (status === 'applied') return <Check size={12} className="flex-shrink-0 text-success" />;
  if (status === 'failed') return <X size={12} className="flex-shrink-0 text-danger" />;
  return <Minus size={12} className="flex-shrink-0 text-fg-faint" />;
}

export function SchemaPlanCard({
  artifact,
  actionId,
  sessionId,
}: {
  artifact: TablesSchemaPlanArtifact;
  actionId?: string;
  sessionId?: string;
}) {
  const t = useT();
  const [applying, setApplying] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [outcome, setOutcome] = useState<SchemaPlanApplyResult | null>(null);
  const [open, setOpen] = useState(true);
  const { receipt, loading: receiptLoading, refresh: refreshReceipt } = useArtifactReceipt(actionId);

  useEffect(() => {
    if (receipt?.status !== 'succeeded' || !receipt.result || typeof receipt.result !== 'object') return;
    setOutcome(receipt.result as SchemaPlanApplyResult);
  }, [receipt]);

  const resultsByIndex = useMemo(() => {
    const map = new Map<number, SchemaPlanOperationResult>();
    for (const result of outcome?.results ?? []) map.set(result.index, result);
    return map;
  }, [outcome]);

  const tally = useMemo(() => {
    const counts = { applied: 0, failed: 0, skipped: 0 };
    for (const result of outcome?.results ?? []) counts[result.status] += 1;
    return counts;
  }, [outcome]);

  const groups = useMemo(
    () =>
      GROUP_ORDER.map((group) => ({
        group,
        entries: artifact.operations
          .map((operation, index) => ({ operation, index }))
          .filter(({ operation }) => OP_GROUP[operation.op] === group),
      })).filter(({ entries }) => entries.length > 0),
    [artifact.operations],
  );

  const run = useCallback(
    async (retry: boolean) => {
      if (applying || !actionId || !sessionId) return;
      setApplying(true);
      try {
        const result = await applyTableSchemaPlan(artifact.operations, { actionId, sessionId }, { retry });
        setOutcome(result);
        const unfinished = result.results.filter((entry) => entry.status !== 'applied').length;
        if (unfinished === 0) toast(t('tablesSchemaPlan.appliedToast'), 'success');
        else toast(t('tablesSchemaPlan.partialToast', { count: unfinished }), 'error');
        if (unfinished === 0) setOpen(false);
        await refreshReceipt();
      } catch (err) {
        toast(err instanceof Error ? err.message : t('tablesSchemaPlan.applyFailed'), 'error');
      } finally {
        setApplying(false);
      }
    },
    [actionId, applying, artifact.operations, refreshReceipt, sessionId, t],
  );

  const allApplied = !!outcome && outcome.results.every((entry) => entry.status === 'applied');
  // The app the plan created (its builder is where it is reviewed, shared and published).
  const createdAppId = outcome?.results.find((entry) => entry.op === 'app.create' && entry.status === 'applied')?.id;
  // Receipts written before retries existed carry no ref map; they cannot be retried safely.
  const retryable = !!outcome && !allApplied && !!outcome.refs;
  const processing = applying || receipt?.status === 'processing';
  const collapsed = !open || dismissed;
  const accessChanges = artifact.accessChanges ?? [];
  const status = receiptLoading
    ? { label: t('common.loading'), tone: 'neutral' as const, busy: true }
    : processing
      ? { label: t('tablesSchemaPlan.applying'), tone: 'info' as const, busy: true }
      : receipt?.status === 'failed'
        ? { label: t('common.failed'), tone: 'danger' as const }
        : outcome
          ? {
              label: allApplied ? t('common.completed') : t('tablesSchemaPlan.partialStatus'),
              tone: allApplied ? ('success' as const) : ('warning' as const),
            }
          : dismissed
            ? { label: t('tablesSchemaPlan.dismissedStatus'), tone: 'neutral' as const }
            : { label: t('tablesSchemaPlan.reviewStatus'), tone: 'primary' as const };

  return (
    <ArtifactCard
      icon={<Columns3 size={14} />}
      title={t('tablesSchemaPlan.title')}
      meta={`${artifact.summary} · ${
        outcome
          ? t('tablesSchemaPlan.tally', tally)
          : t('tablesSchemaPlan.opsCount', { count: artifact.operations.length })
      }`}
      status={status}
      collapsed={collapsed}
      onToggle={outcome || dismissed || receipt?.status === 'failed' ? () => setOpen((value) => !value) : undefined}
      tone={receipt?.status === 'failed' ? 'danger' : allApplied ? 'success' : 'neutral'}
      footer={
        <ArtifactCardActions
          hint={
            receipt?.status === 'failed'
              ? receipt.error
              : outcome
                ? allApplied
                  ? t('tablesSchemaPlan.appliedHint')
                  : t('tablesSchemaPlan.partialHint')
                : dismissed
                  ? t('tablesSchemaPlan.dismissedHint')
                  : t('tablesSchemaPlan.hint')
          }
        >
          {createdAppId !== undefined && (
            <Button size="sm" variant="outline" onClick={() => (window.location.hash = appBuilderHref(createdAppId))}>
              {t('apps.agent.plan.openApp')} →
            </Button>
          )}
          {outcome?.baseId !== undefined && (
            <Button size="sm" variant="outline" onClick={() => (window.location.hash = `#/tables/${outcome.baseId}`)}>
              {t('tablesSchemaPlan.openBase')} →
            </Button>
          )}
          {retryable && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void run(true)}
              disabled={processing || !actionId || !sessionId}
            >
              {processing ? t('tablesSchemaPlan.retrying') : t('tablesSchemaPlan.retry')}
            </Button>
          )}
          {!outcome && !dismissed && receipt?.status !== 'failed' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDismissed(true);
                setOpen(false);
              }}
            >
              {t('tablesSchemaPlan.dismiss')}
            </Button>
          )}
          {!outcome && !dismissed && receipt?.status !== 'failed' && (
            <Button
              size="sm"
              onClick={() => void run(false)}
              disabled={processing || receiptLoading || !actionId || !sessionId}
            >
              {processing ? t('tablesSchemaPlan.applying') : t('tablesSchemaPlan.confirm')}
            </Button>
          )}
        </ArtifactCardActions>
      }
    >
      <div className="space-y-2.5">
        {accessChanges.length > 0 && <AccessChanges changes={accessChanges} />}
        {groups.map(({ group, entries }) => (
          <div key={group} className="space-y-1">
            <p className="text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
              {t(GROUP_LABEL_KEYS[group])}
            </p>
            <ul className="space-y-1">
              {entries.map(({ operation, index }) => {
                const result = resultsByIndex.get(index);
                const detail = operationDetail(operation, t);
                return (
                  <li key={index} className="flex items-start gap-2 text-xs">
                    {result ? (
                      <span className="mt-0.5">
                        <StatusIcon status={result.status} />
                      </span>
                    ) : (
                      <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-fg-faint" />
                    )}
                    <div className="min-w-0 flex-1">
                      <span className="text-fg-muted">{t(OP_LABEL_KEYS[operation.op])}</span>{' '}
                      <span className="font-medium text-fg">
                        {operationTarget(operation, artifact.targetNames?.[index])}
                      </span>
                      {detail && (
                        <span className="text-fg-faint">
                          {' · '}
                          {detail}
                        </span>
                      )}
                      {result?.message && (
                        <p className={`text-[10px] ${result.status === 'applied' ? 'text-fg-muted' : 'text-danger'}`}>
                          {result.message}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </ArtifactCard>
  );
}
