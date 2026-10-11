/**
 * The Tables import wizard (slice I): upload → map columns → check every row
 * (the server's dry run) → import with progress → result with the rows that
 * were skipped. One workspace-size dialog; each step is a function of the
 * state below, and nothing is written before the user presses Import.
 *
 * The import itself is a loop of short commit calls (`commitTableImportAll`);
 * the dialog cannot be closed while it runs. A commit that fails part-way
 * returns to the check step, and pressing Import again resumes it (the server
 * keeps the plan of the first call).
 */

import { useEffect, useMemo, useState } from 'react';
import type { TableImportProgress, TableImportValidation } from '@greenhouse/types/tables';
import { Button, Dialog } from '../../../components/ui';
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
import { FileSpreadsheet } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import { ImportMappingStep } from './mapping-step';
import {
  initialDestinations,
  mappingProblems,
  mappingRequest,
  type ColumnDestination,
  type MappingProblem,
} from './mapping-model';
import { ImportCheckSummary, ImportProgressView, ImportResultView } from './result-steps';
import { ImportUploadStep } from './upload-step';

const MAX_FILE_BYTES = 10 * 1024 * 1024;

type Step = 'upload' | 'mapping' | 'check' | 'importing' | 'done';
const STEP_ORDER: readonly Step[] = ['upload', 'mapping', 'check', 'importing'];

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

export function TablesImportWizard({ open, table, fields, canBuild, onClose, onImported }: TablesImportWizardProps) {
  const t = useT();
  const timeZone = useMemo(browserTimeZone, []);
  const [step, setStep] = useState<Step>('upload');
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
      setHasHeader(true);
      setCreateOptions(false);
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
      setProgress(await commitTableImportAll(table.id, preview.importId, request(), setProgress));
      setStep('done');
      onImported();
    } catch (commitError) {
      setError(commitError instanceof Error ? commitError.message : t('tables.imports.commitFailed'));
      setStep('check');
    }
  };

  const stepLabels: Record<Step, string> = {
    upload: t('tables.imports.steps.upload'),
    mapping: t('tables.imports.steps.mapping'),
    check: t('tables.imports.steps.check'),
    importing: t('tables.imports.steps.import'),
    done: t('tables.imports.steps.import'),
  };
  const position = step === 'done' ? STEP_ORDER.length : STEP_ORDER.indexOf(step) + 1;

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
          {t('tables.imports.stepLabel', { index: position, count: STEP_ORDER.length, name: stepLabels[step] })}
        </div>

        {step === 'upload' && <ImportUploadStep busy={busy} onFile={(file) => void readFile(file)} />}

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
        {step === 'check' && validation && <ImportCheckSummary validation={validation} />}
        {step === 'importing' && (
          <ImportProgressView
            processed={progress?.processedRows ?? 0}
            total={progress?.totalRows ?? validation?.totalRows ?? 0}
          />
        )}
        {step === 'done' && progress && <ImportResultView progress={progress} />}

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
