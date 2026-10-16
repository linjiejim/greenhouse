/** Deleting a base for good: its name typed again (patterns.md, 确认与撤销). */

import { useId, useState } from 'react';
import { Button, Field, Input, Overlay, OverlayActions } from '@greenhouse/ui/kit';
import type { BaseSummary } from '@greenhouse/contract';
import { useNotify } from '../../app/notify';
import { queryClient } from '../../data/query';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { navigate, useRoute } from '../../lib/router';
import { forgetBase } from './entry';
import { tablesError } from './errors';

export function DeleteBaseDialog({ base, onClose }: { base: Pick<BaseSummary, 'id' | 'name'>; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const route = useRoute();
  const formId = useId();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const matches = typed.trim() === base.name.trim();
  const remove = async () => {
    if (!matches) {
      setError(t('tables.deleteMismatch'));
      return;
    }
    setBusy(true);
    try {
      await api.tables.bases.remove(base.id, typed);
      forgetBase(base.id);
      await queryClient.invalidateQueries({ queryKey: ['tables', 'bases'] });
      onClose();
      notify(t('tables.deleted', { name: base.name }));
      if (route.page === 'base' && route.id === base.id) navigate({ page: 'tables' }, { replace: true });
    } catch (failure) {
      setError(tablesError(failure, t));
      setBusy(false);
    }
  };
  return (
    <Overlay variant="dialog" role="alertdialog" title={t('tables.deleteTitle', { name: base.name })} onClose={onClose}>
      <form
        id={formId}
        className="app-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void remove();
        }}
      >
        <p className="gh-confirm-body">{t('tables.deleteBody')}</p>
        <Field label={t('tables.deleteName')} error={error || undefined}>
          <Input
            data-autofocus
            value={typed}
            placeholder={base.name}
            onChange={(event) => {
              setTyped(event.target.value);
              setError('');
            }}
          />
        </Field>
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          kind="danger"
          className="gh-button-solid"
          type="submit"
          form={formId}
          loading={busy}
          disabled={!matches}
        >
          {t('tables.delete')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
