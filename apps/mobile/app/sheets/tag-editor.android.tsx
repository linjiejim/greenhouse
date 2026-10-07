/**
 * Tag editor on Android — a Material 3 form over the shared behaviour
 * (src/chat/use-tag-editor.ts; iOS view: ./tag-editor.tsx): live chip
 * preview, the name field, the 10-color palette and (edit only) 删除标签.
 * Chrome is the shared `FormChrome` (✕ / ✓; system back asks before
 * discarding unsaved edits).
 */

import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { RNHostView } from '@expo/ui/jetpack-compose';
import type { SessionTag } from '../../src/shared/greenhouse-types';
import { useTags } from '../../src/store/tags';
import { TAG_COLORS, tagColorNameKey } from '../../src/lib/tag-colors';
import { useT } from '../../src/lib/i18n';
import { space } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import {
  FormActionRow,
  FormFields,
  FormSection,
  FormSwatchRow,
  FormTextField,
  NativeForm,
  useNativeState,
} from '../../src/ui/native-form.android';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { TagChip } from '../../src/chat/tag-chip';
import { useTagEditor } from '../../src/chat/use-tag-editor';

export default function TagEditorSheet() {
  const t = useT();
  const { id, sessionId } = useLocalSearchParams<{ id?: string; sessionId?: string }>();
  const tags = useTags((s) => s.tags);
  const loaded = useTags((s) => s.loaded);
  const load = useTags((s) => s.load);

  useEffect(() => {
    void load();
  }, [load]);

  const editing = id ? tags.find((x) => x.id === Number(id)) : undefined;
  if (id && !editing) {
    return (
      <>
        <Stack.Screen options={{ title: t('tags.editTag') }} />
        <SheetClose />
        {loaded ? <EmptyState icon="tag" title={t('tags.missing')} /> : <LoadingState />}
      </>
    );
  }
  // keyed so the form's initial values are captured from the right tag
  return <TagEditorForm key={editing?.id ?? 'new'} tag={editing} sessionId={sessionId} />;
}

function TagEditorForm({ tag, sessionId }: { tag?: SessionTag; sessionId?: string }) {
  const t = useT();
  const nameState = useNativeState(tag?.name ?? '');
  const { setName, color, setColor, busy, trimmed, canSave, dirty, save, confirmDelete } = useTagEditor(
    tag,
    sessionId,
    () => nameState.get(),
  );

  return (
    <>
      <FormChrome
        title={tag ? t('tags.editTag') : t('tags.newTag')}
        dirty={dirty}
        canSave={canSave}
        saving={busy}
        onSave={() => void save()}
      />
      <NativeForm>
        <RNHostView matchContents>
          <View style={{ paddingTop: space.sm, paddingHorizontal: space.xs }}>
            <TagChip tag={{ id: -1, name: trimmed || t('tags.namePlaceholder'), color }} />
          </View>
        </RNHostView>

        <FormFields>
          <FormTextField
            label={t('tags.namePlaceholder')}
            state={nameState}
            autoFocus={!tag}
            onChangeText={setName}
            imeAction="done"
            onSubmit={() => void save()}
          />
        </FormFields>

        <FormSection title={t('tags.color')}>
          <FormSwatchRow
            colors={TAG_COLORS}
            value={color}
            onChange={(col) => col && setColor(col)}
            nameOf={(col) => {
              const key = tagColorNameKey(col);
              return key ? t(key) : null;
            }}
          />
        </FormSection>

        {tag ? (
          <FormSection>
            <FormActionRow label={t('tags.deleteTag')} icon="trash" destructive onPress={() => void confirmDelete()} />
          </FormSection>
        ) : null}
      </NativeForm>
    </>
  );
}
