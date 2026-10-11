/**
 * A rule's run log: newest first, each run with its trigger, record, status
 * and the step-by-step log the worker wrote (codes worded here; raw detail
 * such as an HTTP status line shown as-is).
 */

import { useCallback, useEffect, useState } from 'react';
import {
  TABLE_AUTOMATION_RUN_ERRORS,
  type TableAutomationRunError,
  type TableAutomationRunStatus,
  type TableAutomationRunStep,
  type TableAutomationStepCode,
} from '@greenhouse/types/tables';
import { Button, EmptyState, IconButton, Spinner, Tag } from '../../../components/ui';
import { listTableAutomationRuns, type TableAutomation, type TableAutomationRun } from '../../../lib/api/tables';
import { ArrowLeft, History, RefreshCw } from '../../../lib/icons';
import { formatDate, type TagTone } from '../../../lib/utils';
import { useT, type TranslationKey } from '../../../lib/i18n';
import { TRIGGER_LABEL_KEYS } from './rule-draft';

const STATUS_TONES: Record<TableAutomationRunStatus, TagTone> = {
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  canceled: 'warning',
};

const STATUS_KEYS = {
  running: 'tables.automations.run.status.running',
  succeeded: 'tables.automations.run.status.succeeded',
  failed: 'tables.automations.run.status.failed',
  canceled: 'tables.automations.run.status.canceled',
} as const satisfies Record<TableAutomationRunStatus, TranslationKey>;

const STEP_STATUS_KEYS = {
  succeeded: 'tables.automations.run.stepStatus.succeeded',
  failed: 'tables.automations.run.stepStatus.failed',
  skipped: 'tables.automations.run.stepStatus.skipped',
} as const satisfies Record<TableAutomationRunStep['status'], TranslationKey>;

const STEP_CODE_KEYS = {
  record_updated: 'tables.automations.run.code.record_updated',
  record_created: 'tables.automations.run.code.record_created',
  notified: 'tables.automations.run.code.notified',
  webhook_sent: 'tables.automations.run.code.webhook_sent',
  webhook_retrying: 'tables.automations.run.code.webhook_retrying',
  delayed: 'tables.automations.run.code.delayed',
  failed: 'tables.automations.run.code.failed',
} as const satisfies Record<TableAutomationStepCode, TranslationKey>;

const RUN_ERROR_KEYS = {
  rule_changed: 'tables.automations.run.error.rule_changed',
  executor_not_builder: 'tables.automations.run.error.executor_not_builder',
  record_unavailable: 'tables.automations.run.error.record_unavailable',
  table_unavailable: 'tables.automations.run.error.table_unavailable',
  legacy_sync_executor: 'tables.automations.run.error.legacy_sync_executor',
} as const satisfies Record<TableAutomationRunError, TranslationKey>;

function isRunError(value: string | null): value is TableAutomationRunError {
  return value !== null && (TABLE_AUTOMATION_RUN_ERRORS as readonly string[]).includes(value);
}

function StepLine({ step }: { step: TableAutomationRunStep }) {
  const t = useT();
  const params = { ...step.params };
  if (typeof params.until === 'string') params.until = formatDate(params.until);
  const text = step.code ? t(STEP_CODE_KEYS[step.code], params) : step.actionId;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs">
      <Tag size="xs" tone={step.status === 'failed' ? 'danger' : step.status === 'skipped' ? 'warning' : 'neutral'}>
        {t(STEP_STATUS_KEYS[step.status])}
      </Tag>
      <span className="text-fg-secondary">{text}</span>
      {step.message && step.code !== 'record_updated' && (
        <span className="min-w-0 break-words text-fg-faint">{step.message}</span>
      )}
      <span className="ml-auto text-[11px] text-fg-faint">{formatDate(step.at)}</span>
    </li>
  );
}

export function RunLog({ rule, onBack }: { rule: TableAutomation; onBack: () => void }) {
  const t = useT();
  const [runs, setRuns] = useState<TableAutomationRun[] | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setRuns(await listTableAutomationRuns(rule.id, 50));
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('tables.automations.loadRunsFailed'));
    }
  }, [rule.id, t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4" data-testid="automation-run-log">
      <div className="flex items-center gap-2">
        <IconButton label={t('tables.automations.back')} size="compact" onClick={onBack}>
          <ArrowLeft size={15} />
        </IconButton>
        <h4 className="min-w-0 flex-1 truncate text-sm font-semibold text-fg">
          {t('tables.automations.run.title', { name: rule.name })}
        </h4>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw size={13} className="mr-1.5" />
          {t('tables.automations.run.refresh')}
        </Button>
      </div>
      {error && <p className="rounded-md bg-danger-subtle px-3 py-2 text-xs text-danger">{error}</p>}
      {runs === null ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : runs.length === 0 ? (
        <EmptyState icon={History} variant="compact" tone="neutral" title={t('tables.automations.run.empty')} />
      ) : (
        <ul className="divide-y divide-edge rounded-lg border border-edge">
          {runs.map((run) => (
            <li key={run.id} className="space-y-2 px-3 py-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <Tag tone={STATUS_TONES[run.status]}>{t(STATUS_KEYS[run.status])}</Tag>
                <span className="font-medium text-fg">
                  {run.trigger_kind ? t(TRIGGER_LABEL_KEYS[run.trigger_kind]) : '—'}
                </span>
                <span className="text-fg-muted">
                  {run.record_id !== null
                    ? t('tables.automations.run.record', { id: run.record_id })
                    : t('tables.automations.run.noRecord')}
                </span>
                <span className="ml-auto text-fg-faint">
                  {t('tables.automations.run.started', { at: formatDate(run.started_at) })}
                </span>
              </div>
              {run.error && (
                <p className="text-xs text-danger">
                  {isRunError(run.error) ? t(RUN_ERROR_KEYS[run.error]) : run.error}
                </p>
              )}
              {run.steps.length > 0 && (
                <ol className="space-y-1 border-l border-edge pl-3">
                  {run.steps.map((step, index) => (
                    <StepLine key={`${step.actionId}-${index}`} step={step} />
                  ))}
                </ol>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
