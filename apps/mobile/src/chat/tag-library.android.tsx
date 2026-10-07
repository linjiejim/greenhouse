/**
 * TagLibrary on Android — a Material 3 list over the shared behaviour
 * (./use-tag-library.ts; iOS view: ./tag-library.tsx). Same two modes:
 *
 *  - **assign** (`sessionId`; /sheets/session-tags): a checklist — tap a tag to
 *    attach / detach it (radio-style check on attached ones); long-press edits.
 *    A shared conversation lists its tags read-only.
 *  - **manage** (Settings → 标签): tap a tag to edit it; long-press deletes it
 *    (confirmed).
 *
 * Rows lead with the tag's color dot; 新建标签 is the last row.
 */

import React from 'react';
import { useT } from '../lib/i18n';
import { tagHex } from '../lib/tag-colors';
import { FormActionRow, FormCheckRow, FormNavRow, FormSection, FormValueRow, NativeForm } from '../ui/native-form.android';
import { useTagLibrary } from './use-tag-library';

export function TagLibrary({ sessionId }: { sessionId?: string }) {
  const t = useT();
  const { tags, assigned, access, state, assignMode, retry, edit, create, toggle, remove } = useTagLibrary(sessionId);

  const footer =
    access === 'readOnly'
      ? t('tags.readOnly')
      : `${t('tags.hint')}\n${assignMode ? t('tags.assignHintAndroid') : t('tags.manageHintAndroid')}`;

  let rows: React.ReactNode;
  if (state === 'failed') {
    rows = [
      <FormValueRow key="msg" label={t('tags.loadFailed')} muted />,
      <FormActionRow key="retry" label={t('common.retry')} icon="refresh" onPress={retry} />,
    ];
  } else if (state === 'loading') {
    rows = <FormValueRow label={t('common.loading')} muted loading />;
  } else if (state === 'readOnly') {
    rows = assigned?.length ? (
      assigned.map((tag) => <FormValueRow key={tag.id} label={tag.name} dot={tagHex(tag.color)} />)
    ) : (
      <FormValueRow label={t('tags.noneOnSession')} muted />
    );
  } else {
    rows = [
      ...(tags.length === 0
        ? [<FormValueRow key="none" label={t('tags.none')} muted />]
        : tags.map((tag) =>
            assignMode ? (
              <FormCheckRow
                key={tag.id}
                label={tag.name}
                dot={tagHex(tag.color)}
                checked={!!assigned?.some((x) => x.id === tag.id)}
                onPress={() => void toggle(tag)}
                onLongPress={() => edit(tag)}
              />
            ) : (
              <FormNavRow
                key={tag.id}
                label={tag.name}
                dot={tagHex(tag.color)}
                onPress={() => edit(tag)}
                onLongPress={() => void remove(tag)}
              />
            ),
          )),
      <FormActionRow key="new" label={t('tags.newTag')} icon="plus" onPress={create} />,
    ];
  }

  return (
    <NativeForm>
      <FormSection footer={footer}>{rows}</FormSection>
    </NativeForm>
  );
}
