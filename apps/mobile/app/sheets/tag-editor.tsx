/**
 * Tag editor sheet — create (`/sheets/tag-editor`) or edit
 * (`/sheets/tag-editor?id=`) a session tag (Android: ./tag-editor.android.tsx;
 * behaviour: src/chat/use-tag-editor.ts). A SwiftUI Form: live chip preview,
 * name field, the 10-color palette (`ColorSwatchPicker`, spoken color names)
 * and (edit only) a destructive 删除标签. Chrome is the shared `FormChrome`:
 * ✕ asks before discarding unsaved edits, ✓ saves, swipe-to-dismiss is
 * blocked while dirty. Writes go through the tags store, so the library list
 * and any open conversation's chips update in place; failures are system
 * alerts (`alertError`). Opened from a conversation's tag sheet
 * (`?sessionId=`), a newly created tag is attached to that conversation right
 * away (the library refuses to open it for a full conversation; if attaching
 * still fails, the tag stays created and the user is told).
 */

import React, { useEffect } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { Button, RNHostView, Section, TextField, useNativeState } from '@expo/ui/swift-ui';
import { onSubmit, submitLabel } from '@expo/ui/swift-ui/modifiers';
import type { SessionTag } from '../../src/shared/greenhouse-types';
import { useTags } from '../../src/store/tags';
import { TAG_COLORS, tagColorNameKey } from '../../src/lib/tag-colors';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../src/theme';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ColorSwatchPicker, NativeForm } from '../../src/ui/native-form';
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
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  // The native field owns the text; `name` mirrors it for rendering (preview,
  // Save enabled). onTextChange is async, so actions read the native value.
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
        <Section
          header={
            <RNHostView matchContents>
              <View style={styles.preview}>
                <TagChip tag={{ id: -1, name: trimmed || t('tags.namePlaceholder'), color }} />
              </View>
            </RNHostView>
          }
        >
          <TextField
            text={nameState}
            placeholder={t('tags.namePlaceholder')}
            autoFocus={!tag}
            onTextChange={setName}
            modifiers={[submitLabel('done'), onSubmit(() => void save())]}
          />
        </Section>

        <Section title={t('tags.color')}>
          <ColorSwatchPicker
            colors={TAG_COLORS}
            value={color}
            onChange={(col) => col && setColor(col)}
            nameOf={(col) => {
              const key = tagColorNameKey(col);
              return key ? t(key) : null;
            }}
          />
        </Section>

        {tag ? (
          <Section>
            <Button role="destructive" label={t('tags.deleteTag')} onPress={() => void confirmDelete()} />
          </Section>
        ) : null}
      </NativeForm>
    </>
  );
}

const useStyles = makeStyles(() => ({
  preview: { alignItems: 'flex-start', paddingTop: space.sm, paddingBottom: space.xs },
}));
