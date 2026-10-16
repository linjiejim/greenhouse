import { useOverlayDraft } from '../../lib/useOverlayDraft';
/** 重命名 from a page or a list (the directory renames in place). */

import { useId, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Field, Input, Overlay, OverlayActions } from '@greenhouse/ui/kit';
import { DOC_TITLE_MAX, FOLDER_NAME_MAX, type KnowledgeItem } from '@greenhouse/contract';
import { refreshTree, useKnowledgeActions } from '../../data/knowledge';
import { keys } from '../../data/query';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

/** Renames anything; a doc's title is a save, so it goes with the version it is at now. */
export function useRenameItem() {
  const client = useQueryClient();
  const actions = useKnowledgeActions();
  return async (item: Pick<KnowledgeItem, 'type' | 'id'>, name: string) => {
    if (item.type === 'folder') await actions.updateFolder.mutateAsync({ id: item.id, input: { name } });
    else if (item.type === 'file') await actions.updateFile.mutateAsync({ id: item.id, input: { name } });
    else {
      const doc = await api.knowledge.docs.get(item.id);
      const saved = await api.knowledge.docs.update(item.id, { version: doc.version, title: name });
      client.setQueryData(keys.doc(item.id), saved);
      void refreshTree(client);
    }
  };
}

export function RenameDialog({ item, onClose }: { item: KnowledgeItem; onClose: () => void }) {
  const { t } = useI18n();
  const formId = useId();
  const rename = useRenameItem();
  const [name, setName] = useState(item.name);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const dismiss = useOverlayDraft(name, busy, onClose);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const next = name.trim();
    if (!next) return setError(t('knowledge.nameRequired'));
    if (next === item.name) return onClose();
    setBusy(true);
    try {
      await rename(item, next);
      onClose();
    } catch (caught) {
      setError(errorText(caught, t));
      setBusy(false);
    }
  };
  return (
    <>
      <Overlay variant="dialog" title={t('row.rename')} onClose={onClose} beforeClose={dismiss.beforeClose}>
        <form
          {...dismiss.formProps}
          id={formId}
          className="app-form"
          noValidate
          onSubmit={(event) => void submit(event)}
        >
          <Field
            label={item.type === 'doc' ? t('knowledge.title') : t('knowledge.name')}
            error={error || undefined}
            required
          >
            <Input
              data-autofocus
              value={name}
              maxLength={item.type === 'doc' ? DOC_TITLE_MAX : item.type === 'folder' ? FOLDER_NAME_MAX : 200}
              onChange={(event) => {
                setName(event.target.value);
                setError('');
              }}
              onFocus={(event) => event.currentTarget.select()}
            />
          </Field>
        </form>
        <OverlayActions>
          <Button onClick={dismiss.close}>{t('common.cancel')}</Button>
          <Button kind="primary" type="submit" form={formId} loading={busy}>
            {t('row.rename')}
          </Button>
        </OverlayActions>
      </Overlay>
      {dismiss.confirmation}
    </>
  );
}
