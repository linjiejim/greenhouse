import { useOverlayDraft } from '../../../lib/useOverlayDraft';
/**
 * Names a new dashboard of a base and who sees it (everyone who sees the base, or only me;
 * shared ones are for builders), then opens it. With `cards` it is a copy of another dashboard:
 * made empty, then given those cards.
 */

import { useId, useState } from 'react';
import { Button, Field, FieldGroup, Input, Overlay, OverlayActions, Segmented } from '@greenhouse/ui/kit';
import { VIEW_NAME_MAX, roleAtLeast, type Base, type Card } from '@greenhouse/contract';
import { createDashboard } from '../../../data/tables-cards';
import { putView, refreshBase } from '../../../data/tables';
import { api } from '../../../lib/api';
import { useI18n } from '../../../lib/i18n';
import { navigate } from '../../../lib/router';
import { tablesError } from '../errors';

export function NewDashboardDialog({
  base,
  name: initialName,
  cards,
  onClose,
}: {
  base: Base;
  /** Default: 仪表盘. */
  name?: string;
  /** A copy's cards. */
  cards?: Card[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const canBuild = roleAtLeast(base.access, 'builder') && !base.archived_at;
  const [name, setName] = useState(initialName ?? t('tables.view.dashboard'));
  const [personal, setPersonal] = useState(!canBuild);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dismiss = useOverlayDraft({ name, personal }, busy, onClose);
  const create = async () => {
    setBusy(true);
    try {
      let view = await createDashboard(base.id, { name: name.trim() || t('tables.view.dashboard'), personal });
      if (cards?.length) {
        view = await api.tables.views.update(view.id, { revision: view.revision, config: { cards } });
        putView(base.id, view);
        void refreshBase(base.id);
      }
      dismiss.saved();
      navigate({ page: 'base', id: base.id, dashboard: view.id });
    } catch (failure) {
      setError(tablesError(failure, t));
      setBusy(false);
    }
  };
  return (
    <>
      <Overlay
        variant="dialog"
        title={cards ? t('tables.dashboards.duplicateDashboard') : t('tables.addDashboard')}
        onClose={onClose}
        beforeClose={dismiss.beforeClose}
      >
        <form
          {...dismiss.formProps}
          id={formId}
          className="app-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <Field label={t('tables.dashboards.name')} error={error || undefined}>
            <Input
              data-autofocus
              value={name}
              maxLength={VIEW_NAME_MAX}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
          {canBuild && (
            <FieldGroup label={t('tables.viewScope')} description={t('tables.dashboards.scopeHint')}>
              <Segmented
                label={t('tables.viewScope')}
                items={[
                  { value: 'shared', label: t('tables.viewShared') },
                  { value: 'personal', label: t('tables.viewPersonal') },
                ]}
                value={personal ? 'personal' : 'shared'}
                onChange={(next) => setPersonal(next === 'personal')}
              />
            </FieldGroup>
          )}
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form={formId} loading={busy}>
            {t('tables.dashboards.create')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}
