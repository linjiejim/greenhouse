/**
 * Tag editor sheet — create (`/sheets/tag-editor`) or edit
 * (`/sheets/tag-editor?id=`) a session tag. A SwiftUI Form: live chip preview,
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

import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { Button, RNHostView, Section, TextField, useNativeState } from '@expo/ui/swift-ui';
import { onSubmit, submitLabel } from '@expo/ui/swift-ui/modifiers';
import type { SessionTag } from '../../src/shared/greenhouse-types';
import { useTags, type ToggleResult } from '../../src/store/tags';
import { MAX_TAGS_PER_SESSION, MAX_TAGS_PER_USER } from '../../src/api/session-tags';
import { TAG_COLORS, randomTagColor, tagColorNameKey, tagHex } from '../../src/lib/tag-colors';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, useTheme } from '../../src/theme';
import { alertError, confirmAction } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { ColorSwatchPicker, NativeForm } from '../../src/ui/native-form';
import { FormChrome, SheetClose } from '../../src/ui/sheet-chrome';
import { TagChip } from '../../src/chat/tag-chip';

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
  const router = useRouter();
  const create = useTags((s) => s.create);
  const update = useTags((s) => s.update);
  const remove = useTags((s) => s.remove);
  const toggleSessionTag = useTags((s) => s.toggleSessionTag);

  // The native field owns the text; `name` mirrors it for rendering (preview,
  // Save enabled). onTextChange is async, so actions read the native value.
  const nameState = useNativeState(tag?.name ?? '');
  const [name, setName] = useState(tag?.name ?? '');
  // (an off-palette / missing stored color reads as the default gray, not as an edit)
  const [color, setColor] = useState<string>(() => (tag ? tagHex(tag.color) : randomTagColor()));
  const [busy, setBusy] = useState(false);

  const isDirty = (n: string) => !tag || n !== tag.name || color.toLowerCase() !== tagHex(tag.color).toLowerCase();
  const trimmed = name.trim();
  const canSave = !!trimmed && isDirty(trimmed);
  // unsaved edits: FormChrome blocks swipe-to-dismiss and confirms ✕
  const dirty = tag ? isDirty(trimmed) : !!trimmed;

  const save = async () => {
    const value = (nameState.get() ?? name).trim();
    if (busy || !value || !isDirty(value)) return;
    setBusy(true);
    let res: { ok: boolean; error?: string };
    let attach: ToggleResult | null = null;
    if (tag) {
      res = await update(tag.id, { name: value, color });
    } else {
      const r = await create(value, color);
      res = r;
      // attach to the conversation the editor was opened from
      if (r.ok && r.tag && sessionId) attach = await toggleSessionTag(sessionId, r.tag);
    }
    setBusy(false);
    if (!res.ok) {
      const err = res.error?.toLowerCase() ?? '';
      if (err.includes('exists')) alertError(t('tags.duplicate'));
      else if (err.startsWith('maximum')) alertError(t('tags.limitPerUser', { n: MAX_TAGS_PER_USER }));
      else alertError(tag ? t('tags.saveFailed') : t('tags.createFailed'));
      return;
    }
    router.back();
    // the tag exists either way — say so if it couldn't be attached
    if (attach === 'limit') alertError(t('tags.createdNotAttached'), t('tags.limitPerSession', { n: MAX_TAGS_PER_SESSION }));
    else if (attach === 'failed') alertError(t('tags.createdNotAttached'), t('tags.assignFailed'));
  };

  const confirmDelete = async () => {
    if (!tag || busy) return;
    const ok = await confirmAction({
      title: t('tags.deleteTitle'),
      message: t('tags.deleteHint', { name: tag.name }),
      confirmLabel: t('tags.delete'),
      destructive: true,
    });
    if (!ok) return;
    setBusy(true);
    const removed = await remove(tag.id);
    setBusy(false);
    if (removed) router.back();
    else alertError(t('tags.deleteFailed'));
  };

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
