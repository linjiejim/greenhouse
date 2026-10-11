/**
 * Import wizard · what the server answered: the dry run's summary, the
 * progress bar while the commit loop runs, and the final result — each with
 * the rows that were (or will be) skipped and why.
 */

import type { ReactNode } from 'react';
import type { TableImportProgress, TableImportValidation } from '@greenhouse/types/tables';
import { AlertTriangle, CheckCircle2 } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';

type Failures = TableImportValidation['failed'];

function FailureList({ failures, total }: { failures: Failures; total: number }) {
  const t = useT();
  if (failures.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {total > failures.length && (
        <p className="text-xs text-fg-faint">
          {t('tables.imports.firstFailures', { shown: failures.length, count: total })}
        </p>
      )}
      <ul
        className="max-h-72 divide-y divide-edge overflow-y-auto rounded-lg border border-edge"
        data-testid="tables-import-failures"
      >
        {failures.map((failure) => (
          <li key={failure.row} className="flex gap-3 px-3 py-2 text-xs">
            <span className="w-20 flex-shrink-0 font-medium text-fg-secondary">
              {t('tables.imports.rowLabel', { row: failure.row })}
            </span>
            <span className="min-w-0 text-fg-muted">{failure.errors.join(' · ')}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Notice({ tone, children }: { tone: 'warning' | 'danger'; children: ReactNode }) {
  const tones = {
    warning: 'border-warning bg-warning-subtle text-warning',
    danger: 'border-danger bg-danger-subtle text-danger',
  };
  return (
    <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${tones[tone]}`}>
      <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
      <span>{children}</span>
    </div>
  );
}

export function ImportCheckSummary({ validation }: { validation: TableImportValidation }) {
  const t = useT();
  return (
    <div className="space-y-3" data-testid="tables-import-check">
      {validation.missingRequired.length > 0 ? (
        <Notice tone="warning">
          {t('tables.imports.missingRequired', { names: validation.missingRequired.join(', ') })}
        </Notice>
      ) : (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
          <span className="font-medium text-fg">{t('tables.imports.readyRows', { count: validation.validRows })}</span>
          {validation.failedCount > 0 ? (
            <span className="text-warning">{t('tables.imports.failingRows', { count: validation.failedCount })}</span>
          ) : (
            <span className="text-success">{t('tables.imports.allReady')}</span>
          )}
        </div>
      )}
      <FailureList failures={validation.failed} total={validation.failedCount} />
    </div>
  );
}

export function ImportProgressView({ processed, total }: { processed: number; total: number }) {
  const t = useT();
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div className="space-y-2 py-6" data-testid="tables-import-progress">
      <div className="text-sm text-fg-secondary">{t('tables.imports.importing', { done: processed, total })}</div>
      <div
        className="h-2 overflow-hidden rounded-full bg-surface-muted"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div className="h-full rounded-full bg-primary-500 transition-[width]" style={{ width: `${percent}%` }} />
      </div>
      <p className="text-xs text-fg-faint">{t('tables.imports.importingHint')}</p>
    </div>
  );
}

export function ImportResultView({ progress }: { progress: TableImportProgress }) {
  const t = useT();
  const { result } = progress;
  const failedTotal = result.failedCount ?? result.failed.length;
  return (
    <div className="space-y-3" data-testid="tables-import-result">
      {progress.status === 'failed' ? (
        <Notice tone="danger">{t('tables.imports.importFailed', { error: progress.error ?? '' })}</Notice>
      ) : (
        <div className="flex items-center gap-2 text-sm font-medium text-fg">
          <CheckCircle2 size={16} className="text-success" />
          {t('tables.imports.doneTitle')}
        </div>
      )}
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-fg-secondary">
        <span>{t('tables.imports.created', { count: result.created })}</span>
        {failedTotal > 0 && <span className="text-warning">{t('tables.imports.failed', { count: failedTotal })}</span>}
        {result.createdFieldIds.length > 0 && (
          <span>{t('tables.imports.newFields', { count: result.createdFieldIds.length })}</span>
        )}
      </div>
      {failedTotal === 0 && progress.status !== 'failed' && (
        <p className="text-xs text-fg-faint">{t('tables.imports.noFailures')}</p>
      )}
      <FailureList failures={result.failed} total={failedTotal} />
    </div>
  );
}
