/**
 * SchemaPlanCard — the body artifact behind the `tables_schema_plan` tool.
 *
 * The card IS the confirm gate: the tool wrote nothing, so until the user
 * presses Confirm no Base, table or field exists. Confirm posts the plan to
 * /api/tables/schema-plan/apply with the user's own session, and the server
 * re-authorizes every operation — so a tampered plan can never do more than
 * its sender could already do by hand.
 *
 * Schema operations are inherently non-idempotent, so the card derives a stable
 * message-position action id. The server atomically claims it before applying
 * anything and persists the exact result; refresh restores that receipt instead
 * of re-arming the Confirm button.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { SchemaPlanOperation, SchemaPlanOperationResult, SchemaPlanApplyResult } from '@greenhouse/types/tables';
import { Columns3, Check, X, Minus } from '@greenhouse/web/extension-kit';
import { Button, toast } from '@greenhouse/web/extension-kit';
import { useT } from '@greenhouse/web/extension-kit';
import { applyTableSchemaPlan } from '../api';
import { useArtifactReceipt } from '@greenhouse/web/extension-kit';
import { ArtifactCard, ArtifactCardActions } from '@greenhouse/web/extension-kit';

/** Mirror of the server artifact payload (plugins/tables/api/tools/tables-schema-plan.ts). */
export interface TablesSchemaPlanArtifact {
  type: 'tables_schema_plan';
  summary: string;
  operations: SchemaPlanOperation[];
}

const OP_LABEL_KEYS = {
  'base.create': 'ext.tables.tablesSchemaPlan.opBaseCreate',
  'base.update': 'ext.tables.tablesSchemaPlan.opBaseUpdate',
  'table.create': 'ext.tables.tablesSchemaPlan.opTableCreate',
  'table.update': 'ext.tables.tablesSchemaPlan.opTableUpdate',
  'field.create': 'ext.tables.tablesSchemaPlan.opFieldCreate',
  'field.update': 'ext.tables.tablesSchemaPlan.opFieldUpdate',
  'field.archive': 'ext.tables.tablesSchemaPlan.opFieldArchive',
} as const satisfies Record<SchemaPlanOperation['op'], string>;

/** What the operation is about, in the user's words rather than ids where possible. */
function operationTarget(operation: SchemaPlanOperation): string {
  switch (operation.op) {
    case 'base.create':
    case 'table.create':
    case 'field.create':
      return operation.name;
    case 'base.update':
      return operation.name ?? `#${operation.baseId}`;
    case 'table.update':
      return operation.name ?? `#${operation.tableId}`;
    case 'field.update':
      return operation.name ?? `#${operation.fieldId}`;
    case 'field.archive':
      return `#${operation.fieldId}`;
  }
}

function isFieldOperation(operation: SchemaPlanOperation): boolean {
  return operation.op.startsWith('field.');
}

function StatusIcon({ status }: { status: SchemaPlanOperationResult['status'] }) {
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

  const handleConfirm = useCallback(async () => {
    if (applying || !actionId || !sessionId) return;
    setApplying(true);
    try {
      const result = await applyTableSchemaPlan(artifact.operations, { actionId, sessionId });
      setOutcome(result);
      const failed = result.results.filter((entry) => entry.status !== 'applied').length;
      if (failed === 0) toast(t('ext.tables.tablesSchemaPlan.appliedToast'), 'success');
      else toast(t('ext.tables.tablesSchemaPlan.partialToast', { count: failed }), 'error');
      if (failed === 0) setOpen(false);
      await refreshReceipt();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('ext.tables.tablesSchemaPlan.applyFailed'), 'error');
    } finally {
      setApplying(false);
    }
  }, [actionId, applying, artifact.operations, refreshReceipt, sessionId, t]);

  const allApplied = !!outcome && outcome.results.every((entry) => entry.status === 'applied');
  const processing = applying || receipt?.status === 'processing';
  const collapsed = !open || dismissed;
  const status = receiptLoading
    ? { label: t('common.loading'), tone: 'neutral' as const, busy: true }
    : processing
      ? { label: t('ext.tables.tablesSchemaPlan.applying'), tone: 'info' as const, busy: true }
      : receipt?.status === 'failed'
        ? { label: t('common.failed'), tone: 'danger' as const }
        : outcome
          ? {
              label: allApplied ? t('common.completed') : t('ext.tables.tablesSchemaPlan.partialStatus'),
              tone: allApplied ? ('success' as const) : ('warning' as const),
            }
          : dismissed
            ? { label: t('ext.tables.tablesSchemaPlan.dismissedStatus'), tone: 'neutral' as const }
            : { label: t('ext.tables.tablesSchemaPlan.reviewStatus'), tone: 'primary' as const };

  return (
    <ArtifactCard
      icon={<Columns3 size={14} />}
      title={t('ext.tables.tablesSchemaPlan.title')}
      meta={`${artifact.summary} · ${
        outcome
          ? t('ext.tables.tablesSchemaPlan.tally', tally)
          : t('ext.tables.tablesSchemaPlan.opsCount', { count: artifact.operations.length })
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
                ? t('ext.tables.tablesSchemaPlan.appliedHint')
                : dismissed
                  ? t('ext.tables.tablesSchemaPlan.dismissedHint')
                  : t('ext.tables.tablesSchemaPlan.hint')
          }
        >
          {outcome?.baseId !== undefined && (
            <Button size="sm" variant="outline" onClick={() => (window.location.hash = `#/tables/${outcome.baseId}`)}>
              {t('ext.tables.tablesSchemaPlan.openBase')} →
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
              {t('ext.tables.tablesSchemaPlan.dismiss')}
            </Button>
          )}
          {!outcome && !dismissed && receipt?.status !== 'failed' && (
            <Button
              size="sm"
              onClick={() => void handleConfirm()}
              disabled={processing || receiptLoading || !actionId || !sessionId}
            >
              {processing ? t('ext.tables.tablesSchemaPlan.applying') : t('ext.tables.tablesSchemaPlan.confirm')}
            </Button>
          )}
        </ArtifactCardActions>
      }
    >
      <div className="space-y-2.5">
        <ul className="space-y-1">
          {artifact.operations.map((operation, index) => {
            const result = resultsByIndex.get(index);
            return (
              <li key={index} className={`flex items-start gap-2 text-xs ${isFieldOperation(operation) ? 'pl-4' : ''}`}>
                {result ? (
                  <span className="mt-0.5">
                    <StatusIcon status={result.status} />
                  </span>
                ) : (
                  <span className="mt-1.5 h-1 w-1 flex-shrink-0 rounded-full bg-fg-faint" />
                )}
                <div className="min-w-0 flex-1">
                  <span className="text-fg-muted">{t(OP_LABEL_KEYS[operation.op])}</span>{' '}
                  <span className="font-medium text-fg">{operationTarget(operation)}</span>
                  {operation.op === 'field.create' && (
                    <span className="text-fg-faint">
                      {' · '}
                      {operation.type}
                      {operation.required ? ` · ${t('ext.tables.tablesSchemaPlan.required')}` : ''}
                    </span>
                  )}
                  {result?.message && <p className="text-caption text-danger">{result.message}</p>}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </ArtifactCard>
  );
}
