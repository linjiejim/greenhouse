/**
 * Knowledge editor — a notes-style native editor for one doc: a borderless
 * title input over a full-bleed multiline Markdown source input (plain
 * TextInputs, so selection / autocorrect / scroll-to-caret are the OS's own).
 * Saving PUTs title + content_markdown (the server records the version and
 * re-derives the rich-editor JSON); closing with unsaved changes asks first.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Text, TextInput, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { canEditDoc, getDoc, updateDoc, type KnowledgeDoc } from '../../src/api/knowledge';
import { useBottomPadStyle } from '../../src/lib/keyboard';
import { useT } from '../../src/lib/i18n';
import { EmptyState, ScreenHeader, Skeleton, Spinner, Touchable } from '../../src/ui';
import { font, makeStyles, useTheme, weight } from '../../src/theme';

export default function KnowledgeEdit() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const params = useLocalSearchParams<{ slug: string }>();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const rootPad = useBottomPadStyle(insets.bottom);

  const [doc, setDoc] = useState<KnowledgeDoc | null | 'missing'>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      const d = await getDoc(String(params.slug));
      if (!alive) return;
      if (!d || !canEditDoc(d)) {
        setDoc('missing');
        return;
      }
      setDoc(d);
      setTitle(d.title);
      setContent(d.content_markdown || '');
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loaded = doc !== null && doc !== 'missing' ? doc : null;
  const dirty = !!loaded && (title !== loaded.title || content !== (loaded.content_markdown || ''));
  const canSave = !!loaded && dirty && !!title.trim() && !saving;

  const close = useCallback(() => {
    if (!dirty) {
      router.back();
      return;
    }
    Alert.alert(t('knowledge.discardTitle'), t('knowledge.discardHint'), [
      { text: t('knowledge.discardKeep'), style: 'cancel' },
      { text: t('knowledge.discardDrop'), style: 'destructive', onPress: () => router.back() },
    ]);
  }, [dirty, router, t]);

  const save = useCallback(async () => {
    if (!loaded || !canSave) return;
    setSaving(true);
    const updated = await updateDoc(loaded.id, { title: title.trim(), content_markdown: content });
    setSaving(false);
    if (!updated) {
      Alert.alert(t('knowledge.saveFailed'));
      return;
    }
    router.back();
  }, [loaded, canSave, title, content, router, t]);

  return (
    <Animated.View style={[styles.root, { paddingTop: insets.top + 2 }, rootPad]}>
      <ScreenHeader
        variant="compact"
        align="left"
        leading="close"
        title={t('knowledge.editTitle')}
        onLeading={close}
        bordered
        right={
          <Touchable haptic="none" onPress={save} disabled={!canSave} style={styles.saveBtn}>
            {saving ? <Spinner size={15} /> : <Text style={[styles.saveText, !canSave && { color: c.fgFaint }]}>{t('knowledge.save')}</Text>}
          </Touchable>
        }
      />

      {doc === null ? (
        <View style={{ paddingHorizontal: 16, gap: 12, paddingTop: 16 }}>
          <Skeleton style={{ height: 28, width: '70%', borderRadius: 8 }} />
          <Skeleton style={{ height: 16, borderRadius: 8 }} />
          <Skeleton style={{ height: 16, width: '85%', borderRadius: 8 }} />
        </View>
      ) : doc === 'missing' ? (
        <EmptyState icon="book" title={t('knowledge.missing')} sub={t('knowledge.missingHint')} />
      ) : (
        <>
          <TextInput
            value={title}
            onChangeText={setTitle}
            placeholder={t('knowledge.titlePlaceholder')}
            placeholderTextColor={c.fgFaint}
            style={styles.titleInput}
            returnKeyType="next"
          />
          <TextInput
            value={content}
            onChangeText={setContent}
            placeholder={t('knowledge.contentPlaceholder')}
            placeholderTextColor={c.fgFaint}
            style={styles.contentInput}
            multiline
            textAlignVertical="top"
            scrollEnabled
            autoCapitalize="none"
          />
        </>
      )}
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  root: { flex: 1, backgroundColor: c.bg },
  saveBtn: { minWidth: 52, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 10 },
  saveText: { fontSize: font.title, fontWeight: weight.semibold, color: c.accent },

  titleInput: {
    fontSize: font.large,
    fontWeight: weight.bold,
    color: c.fg,
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 10,
  },
  contentInput: {
    flex: 1,
    fontSize: font.body,
    lineHeight: 24,
    color: c.fg,
    paddingHorizontal: 16,
    paddingTop: 2,
    paddingBottom: 16,
  },
}));
