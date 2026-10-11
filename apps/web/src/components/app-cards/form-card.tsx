/**
 * Form card (`kind: 'form'`): the card's fields of its table, filled in place
 * and sent as `$submit` (the spec's `defaults` are applied by the server, never
 * shown). Attachments upload through the app; after a submit the card says so
 * — the builder's message, else ours — and offers another response.
 */

import { useMemo, useState } from 'react';
import { isComputedField } from '../tables/field-types';
import { Button } from '../ui';
import { useT } from '../../lib/i18n';
import { CheckCircle2 } from '../../lib/icons';
import { appTableFields, pickFields, viewTable } from './model';
import { AppRecordForm } from './record-form';
import type { AppCardRendererProps } from './types';

export function AppFormCard({ card, host }: AppCardRendererProps<'form'>) {
  const t = useT();
  const table = viewTable(host.view, card.tableId);
  const fields = useMemo(
    () => pickFields(appTableFields(table), card.fieldIds).filter((field) => !isComputedField(field)),
    [card.fieldIds, table],
  );
  const [done, setDone] = useState(false);
  /** Bumped per response so the next one starts blank. */
  const [round, setRound] = useState(0);

  if (done) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-3 py-4 text-center"
        data-testid={`app-form-${card.id}-done`}
      >
        <CheckCircle2 size={28} className="text-success" aria-hidden="true" />
        <p className="text-sm font-medium text-fg">{t('apps.runtime.form.successTitle')}</p>
        <p className="max-w-sm text-xs text-fg-muted">
          {card.successMessage?.trim() || t('apps.runtime.form.successDefault')}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setRound((value) => value + 1);
            setDone(false);
          }}
        >
          {t('apps.runtime.form.again')}
        </Button>
      </div>
    );
  }

  return (
    <AppRecordForm
      key={round}
      fields={fields}
      mode="create"
      loadOptions={(fieldId) => host.loadOptions(card, fieldId)}
      upload={(fieldId, file) => host.upload(card, fieldId, file)}
      submitLabel={card.submitLabel?.trim() || t('apps.runtime.form.submit')}
      describeError={host.describeError}
      onSubmit={async (values) => {
        await host.submitForm(card, values);
        setDone(true);
      }}
      stickyActions
      testId={`app-form-${card.id}`}
    />
  );
}
