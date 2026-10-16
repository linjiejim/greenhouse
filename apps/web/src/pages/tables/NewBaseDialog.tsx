import { useOverlayDraft } from '../../lib/useOverlayDraft';
/** 新建表格: a blank base with one table, or one from the 「项目」 template; then it opens. */

import { useId, useState } from 'react';
import { FolderKanban, Table2 } from 'lucide-react';
import { Button, Field, Input, Overlay, OverlayActions } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { BaseTemplate } from '@greenhouse/contract';
import { refreshBase, tablesKeys } from '../../data/tables';
import { queryClient } from '../../data/query';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { tablesError } from './errors';

export function NewBaseDialog({ template: initial, onClose }: { template?: BaseTemplate; onClose: () => void }) {
  const { t } = useI18n();
  const formId = useId();
  const [template, setTemplate] = useState<BaseTemplate | null>(initial ?? null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dismiss = useOverlayDraft({ template, name }, busy, onClose);
  const choices = [
    { value: null, title: t('tables.blank'), hint: t('tables.blankHint'), Icon: Table2 },
    { value: 'project' as const, title: t('tables.project'), hint: t('tables.projectHint'), Icon: FolderKanban },
  ];
  const create = async () => {
    setBusy(true);
    setError('');
    try {
      const base = await api.tables.bases.create({
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(template ? { template } : {}),
      });
      queryClient.setQueryData(tablesKeys.base(base.id), base);
      void refreshBase(base.id);
      dismiss.saved();
      navigate({ page: 'base', id: base.id });
    } catch (failure) {
      setError(tablesError(failure, t));
      setBusy(false);
    }
  };
  return (
    <>
      <Overlay variant="dialog" wide title={t('tables.newTitle')} onClose={onClose} beforeClose={dismiss.beforeClose}>
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
          <div className="app-tb-choices" role="radiogroup" aria-label={t('tables.newTitle')}>
            {choices.map((choice) => (
              <button
                key={choice.title}
                type="button"
                role="radio"
                aria-checked={template === choice.value}
                className={cx('app-tb-choice', template === choice.value && 'is-on')}
                onClick={() => setTemplate(choice.value)}
              >
                <choice.Icon size={icon.lg} strokeWidth={icon.stroke} aria-hidden />
                <span className="app-tb-choice-title">{choice.title}</span>
                <span className="app-tb-choice-hint">{choice.hint}</span>
              </button>
            ))}
          </div>
          <Field label={t('tables.name')} error={error || undefined}>
            <Input
              data-autofocus
              value={name}
              maxLength={100}
              placeholder={template === 'project' ? t('tables.project') : t('tables.namePlaceholder')}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form={formId} loading={busy}>
            {t('tables.create')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}
