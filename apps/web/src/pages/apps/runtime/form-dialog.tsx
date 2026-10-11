/**
 * A centred dialog around the one app form (`AppRecordForm`): creating a
 * record (a records card's "new", a `create_record` button), editing a
 * record's detail fields, and an action that collects input before it runs
 * (its confirmation text above the fields).
 */

import type { AppFieldOptionsView, AppUploadView } from '@greenhouse/types/apps';
import type { TableFieldValueEntry } from '@greenhouse/types/tables';
import { AppRecordForm } from '../../../components/app-cards';
import { Dialog } from '../../../components/ui';
import type { TableField } from '../../../lib/api/tables';

export interface AppFormRequest {
  title: string;
  fields: TableField[];
  requiredFieldIds?: ReadonlySet<number>;
  initialValues?: Record<string, unknown>;
  mode: 'create' | 'update';
  submitLabel: string;
  /** Shown above the fields (an action's confirmation text). */
  intro?: string;
  loadOptions?: (fieldId: number) => Promise<AppFieldOptionsView>;
  upload?: (fieldId: number, file: File) => Promise<AppUploadView>;
  /** Resolves when stored (the dialog then closes); throws a refusal to show in the form. */
  onSubmit: (values: TableFieldValueEntry[]) => Promise<void>;
  testId: string;
}

export function AppFormDialog({
  request,
  onClose,
  describeError,
}: {
  request: AppFormRequest | null;
  onClose: () => void;
  describeError: (error: unknown) => string;
}) {
  return (
    <Dialog open={request !== null} onClose={onClose} title={request?.title ?? ''} size="lg">
      {request && (
        <AppRecordForm
          fields={request.fields}
          requiredFieldIds={request.requiredFieldIds}
          initialValues={request.initialValues}
          mode={request.mode}
          loadOptions={request.loadOptions}
          upload={request.upload}
          submitLabel={request.submitLabel}
          describeError={describeError}
          onCancel={onClose}
          onSubmit={async (values) => {
            await request.onSubmit(values);
            onClose();
          }}
          intro={request.intro ? <p className="text-sm text-fg-secondary">{request.intro}</p> : undefined}
          testId={request.testId}
        />
      )}
    </Dialog>
  );
}
