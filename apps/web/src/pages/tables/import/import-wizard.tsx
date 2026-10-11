/**
 * The Tables import wizard (slice I): upload → map columns → check every row
 * (the server's dry run) → import with progress → result with the rows that
 * were skipped. One workspace-size dialog; each step is a function of the
 * state below, and nothing is written before the user presses Import.
 *
 * The import itself is a loop of short commit calls (`commitTableImportAll`);
 * the dialog cannot be closed while it runs.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { TableImportProgress, TableImportValidation } from '@greenhouse/types/tables';
import { Button, Dialog, Spinner } from '../../../components/ui';
import { FormActions, FormError } from '../../../components/form';
import {
  commitTableImportAll,
  uploadTableImport,
  validateTableImport,
  type TableDefinition,
  type TableField,
  type TableImportPreview,
  type TableImportRequest,
} from '../../../lib/api/tables';
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Upload } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import { ImportMappingStep } from './mapping-step';
import {
  initialDestinations,
  mappingProblems,
  mappingRequest,
  type ColumnDestination,
  type MappingProblem,
} from './mapping-model';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPT = '.csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Step = 'upload' | 'mapping' | 'check' | 'importing' | 'done';

interface TablesImportWizardProps {
  open: boolean;
  table: TableDefinition;
  fields: TableField[];
  /** Builder or owner: may create fields and options. */
  canBuild: boolean;
  onClose: () => void;
  /** Records (and maybe fields) were written: reload. */
  onImported: () => void;
}

function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function FailureList({ failures }: { failures: Array<{ row: number; errors: string[] }> }) {
  const t = useT();
  if (failures.length === 0) return null;
  return (
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
  );
}

export function TablesImportWizard({ open, table, fields, canBuild, onClose, onImported }: TablesImportWizardProps) {
  const t = useT();
  const timeZone = useMemo(browserTimeZone, []);
  const inputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<Step>('upload');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<TableImportPreview | null>(null);
  const [destinations, setDestinations] = useState<ColumnDestination[]>([]);
  const [hasHeader, setHasHeader] = useState(true);
  const [createOptions, setCreateOptions] = useState(false);
  const [validation, setValidation] = useState<TableImportValidation | null>(null);
  const [progress, setProgress] = useState<TableImportProgress | null>(null);

  useEffect(() => {
    if (!open) return;
    setStep('upload');
    setPreview(null);
    setDestinations([]);
    setHasHeader(true);
    setCreateOptions(false);
    setValidation(null);
    setProgress(null);
    setError('');
  }, [open]);

  const request = (): TableImportRequest => ({
    mapping: mappingRequest(destinations),
    hasHeader,
    createOptions: canBuild && createOptions,
    timezone: timeZone,
  });
  const problems = mappingProblems(destinations, fields);

  const problemText = (problem: MappingProblem): string => {
    if (problem.key === 'duplicateField') return t('tables.imports.duplicateField', { name: problem.name });
    if (problem.key === 'duplicateName') return t('tables.imports.duplicateName', { name: problem.name });
    if (problem.key === 'emptyName') return t('tables.imports.emptyName');
    return t('tables.imports.nothingMapped');
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    if (file.size > MAX_FILE_BYTES) {
      setError(t('tables.imports.tooLarge'));
      return;
    }
    setBusy(true);
    try {
      const next = await uploadTableImport(table.id, file);
      setPreview(next);
      setDestinations(initialDestinations(next.columns, canBuild));
      setStep('mapping');
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : t('tables.imports.uploadFailed'));
    } finally {
      setBusy(false);
    }
  };

  const check = async () => {
    if (!preview || problems.length > 0) return;
    setBusy(true);
    setError('');
    try {
      setValidation(await validateTableImport(table.id, preview.importId, request()));
      setStep('check');
    } catch (checkError) {
      setError(checkError instanceof Error ? checkError.message : t('tables.imports.checkFailed'));
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!preview) return;
    setStep('importing');
    setError('');
    try {
      const final = await commitTableImportAll(table.id, preview.importId, request(), setProgress);
      setProgress(final);
      setStep('done');
      onImported();
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : t('tables.imports.commitFailed'));
      setStep('check');
    }
  };

  const steps: Array<{ key: Step; label: string }> = [
    { key: 'upload', label: t('tables.imports.steps.upload') },
    { key: 'mapping', label: t('tables.imports.steps.mapping') },
    { key: 'check', label: t('tables.imports.steps.check') },
    { key: 'importing', label: t('tables.imports.steps.import') },
  ];
  const stepIndex = Math.min(
    steps.findIndex((entry) => entry.key === step),
    3,
  );
  const currentStep = steps[step === 'done' ? 3 : stepIndex]!;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (step !== 'importing') onClose();
      }}
      title={t('tables.imports.title', { table: table.name })}
      size="workspace"
    >
      <div className="space-y-4" data-testid="tables-import-dialog">
        <div className="text-xs text-fg-faint">
          {t('tables.imports.stepLabel', {
            index: (step === 'done' ? 3 : stepIndex) + 1,
            count: steps.length,
            name: currentStep.label,
          })}
        </div>

        {step === 'upload' && (
          <div
            role="button"
            tabIndex={0}
            data-testid="tables-import-dropzone"
            onClick={() => inputRef.current?.click()}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click();
            }}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void readFile(event.dataTransfer.files[0]);
            }}
            className={`cursor-pointer rounded-lg border border-dashed px-4 py-12 text-center transition-colors ${
              dragging ? 'border-primary-500 bg-primary-subtle' : 'border-edge-strong hover:bg-surface-muted'
            }`}
          >
            {busy ? (
              <Spinner className="mx-auto h-5 w-5 text-fg-faint" />
            ) : (
              <Upload size={20} className="mx-auto text-fg-faint" />
            )}
            <div className="mt-2 text-sm text-fg-secondary">
              {busy ? t('tables.imports.reading') : t('tables.imports.dropHint')}
            </div>
            <div className="mt-0.5 text-xs text-fg-faint">{t('tables.imports.limits')}</div>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              className="hidden"
              data-testid="tables-import-file"
              onChange={(event) => {
                void readFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
          </div>
        )}

        {preview && step !== 'upload' && (
          <div className="flex items-center gap-2 text-sm text-fg-secondary">
            <FileSpreadsheet size={16} className="flex-shrink-0 text-fg-faint" />
            <span className="truncate" title={preview.fileName}>
              {t('tables.imports.fileSummary', {
                name: preview.fileName,
                rows: hasHeader ? preview.rowCount : preview.rowCount + 1,
                columns: preview.columns.length,
              })}
            </span>
          </div>
        )}

        {step === 'mapping' && preview && (
          <ImportMappingStep
            preview={preview}
            fields={fields}
            destinations={destinations}
            hasHeader={hasHeader}
            createOptions={createOptions}
            canBuild={canBuild}
            timeZone={timeZone}
            onDestinationsChange={setDestinations}
            onHasHeaderChange={setHasHeader}
            onCreateOptionsChange={setCreateOptions}
          />
        )}

        {step === 'check' && validation && (
          <div className="space-y-3" data-testid="tables-import-check">
            {validation.missingRequired.length > 0 ? (
              <div className="flex items-start gap-2 rounded-md border border-warning bg-warning-subtle px-3 py-2 text-sm text-warning">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{t('tables.imports.missingRequired', { names: validation.missingRequired.join(', ') })}</span>
              </div>
            ) : (
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span className="font-medium text-fg">
                  {t('tables.imports.readyRows', { count: validation.validRows })}
                </span>
                {validation.failedCount > 0 ? (
                  <span className="text-warning">
                    {t('tables.imports.failingRows', { count: validation.failedCount })}
                  </span>
                ) : (
                  <span className="text-success">{t('tables.imports.allReady')}</span>
                )}
              </div>
            )}
            {validation.failedCount > validation.failed.length && (
              <p className="text-xs text-fg-faint">
                {t('tables.imports.firstFailures', { shown: validation.failed.length, count: validation.failedCount })}
              </p>
            )}
            <FailureList failures={validation.failed} />
          </div>
        )}

        {step === 'importing' && (
          <div className="space-y-2 py-6" data-testid="tables-import-progress">
            <div className="text-sm text-fg-secondary">
              {t('tables.imports.importing', {
                done: progress?.processedRows ?? 0,
                total: progress?.totalRows ?? validation?.totalRows ?? 0,
              })}
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-surface-muted">
              <div
                className="h-full rounded-full bg-primary-500 transition-[width]"
                style={{
                  width: `${progress && progress.totalRows > 0 ? Math.round((progress.processedRows / progress.totalRows) * 100) : 0}%`,
                }}
              />
            </div>
            <p className="text-xs text-fg-faint">{t('tables.imports.importingHint')}</p>
          </div>
        )}

        {step === 'done' && progress && (
          <div className="space-y-3" data-testid="tables-import-result">
            {progress.status === 'failed' ? (
              <div className="flex items-start gap-2 rounded-md border border-danger bg-danger-subtle px-3 py-2 text-sm text-danger">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{t('tables.imports.importFailed', { error: progress.error ?? '' })}</span>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm font-medium text-fg">
                <CheckCircle2 size={16} className="text-success" />
                {t('tables.imports.doneTitle')}
              </div>
            )}
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm text-fg-secondary">
              <span>{t('tables.imports.created', { count: progress.result.created })}</span>
              {(progress.result.failedCount ?? progress.result.failed.length) > 0 && (
                <span className="text-warning">
                  {t('tables.imports.failed', { count: progress.result.failedCount ?? progress.result.failed.length })}
                </span>
              )}
              {progress.result.createdFieldIds.length > 0 && (
                <span>{t('tables.imports.newFields', { count: progress.result.createdFieldIds.length })}</span>
              )}
            </div>
            {progress.result.failed.length === 0 && progress.status !== 'failed' && (
              <p className="text-xs text-fg-faint">{t('tables.imports.noFailures')}</p>
            )}
            {(progress.result.failedCount ?? 0) > progress.result.failed.length && (
              <p className="text-xs text-fg-faint">
                {t('tables.imports.firstFailures', {
                  shown: progress.result.failed.length,
                  count: progress.result.failedCount ?? 0,
                })}
              </p>
            )}
            <FailureList failures={progress.result.failed} />
          </div>
        )}

        {step === 'mapping' && problems.length > 0 && <FormError>{problemText(problems[0]!)}</FormError>}
        {error && <FormError>{error}</FormError>}

        {step !== 'upload' && step !== 'importing' && (
          <FormActions
            leading={
              step === 'mapping' ? (
                <Button variant="ghost" size="sm" onClick={() => setStep('upload')}>
                  {t('tables.imports.chooseAnother')}
                </Button>
              ) : step === 'check' ? (
                <Button variant="ghost" size="sm" onClick={() => setStep('mapping')}>
                  {t('tables.imports.back')}
                </Button>
              ) : null
            }
          >
            {step === 'mapping' && (
              <Button
                size="sm"
                data-testid="tables-import-check-button"
                disabled={busy || problems.length > 0}
                onClick={() => void check()}
              >
                {busy ? t('tables.imports.checking') : t('tables.imports.check')}
              </Button>
            )}
            {step === 'check' && validation && (
              <Button
                size="sm"
                data-testid="tables-import-start"
                disabled={validation.missingRequired.length > 0 || validation.validRows === 0}
                onClick={() => void runImport()}
              >
                {t('tables.imports.start', { count: validation.validRows })}
              </Button>
            )}
            {step === 'done' && (
              <Button size="sm" data-testid="tables-import-done" onClick={onClose}>
                {t('tables.imports.done')}
              </Button>
            )}
          </FormActions>
        )}
      </div>
    </Dialog>
  );
}
