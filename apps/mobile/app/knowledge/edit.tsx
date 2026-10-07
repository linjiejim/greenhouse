/**
 * Knowledge editor — a page-sheet modal with its own native navigation bar
 * (presentation declared in app/_layout.tsx). The bar is the shared
 * `FormChrome`: ✕ 取消 (asks before discarding unsaved changes), ✓ 保存
 * (accent "done" button, enabled only when there is a change and a title;
 * both disabled while saving) — and swipe-to-dismiss is blocked while there
 * are unsaved changes or a save is in flight, so an accidental swipe never
 * loses edits (a clean editor swipes away like any sheet).
 *
 * The body is Notes-style: a borderless bold title over a hairline and the
 * Markdown source in a growing multiline input, both plain system TextInputs
 * (selection, autocorrect, dictation, undo are the OS's own). The keyboard-aware
 * scroll view (react-native-keyboard-controller) keeps the caret above the
 * keyboard while typing anywhere in a long document. The source input has no
 * auto-capitalization / autocorrect (they rewrite Markdown syntax and code,
 * and smart quotes follow autocorrect). ✓ puts the keyboard away and locks the
 * inputs until the request settles.
 *
 * Saving PUTs title + content_markdown + `base_updated_at` (the `updated_at`
 * loaded here) — the server records a version, re-derives the rich-editor JSON
 * and flags a concurrent edit (`conflict`; the save still wins). Feedback
 * (src/ui/dialogs.ts policy): saved → toast; failed → `alertError`, the editor
 * stays open with the edits; saved-with-conflict → `alertError` too (see
 * `save`). A doc the viewer can only read gets a no-permission state; a failed
 * load offers 重试. Accepts `?slug=` and the authoritative `?id=`.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, TextInput, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { canEditDoc, resolveDoc, updateDoc, type DocMiss, type KnowledgeDoc } from '../../src/api/knowledge';
import { useT } from '../../src/lib/i18n';
import { makeStyles, space, typo, useTheme } from '../../src/theme';
import { alertError } from '../../src/ui/dialogs';
import { EmptyState, LoadingState } from '../../src/ui/empty';
import { FormChrome } from '../../src/ui/sheet-chrome';
import { toast } from '../../src/ui/toast';

export default function KnowledgeEdit() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const router = useRouter();
  const { slug, id } = useLocalSearchParams<{ slug: string; id?: string }>();
  const { height: windowHeight } = useWindowDimensions();
  const bodyRef = useRef<TextInput>(null);

  const [doc, setDoc] = useState<KnowledgeDoc | DocMiss | 'readOnly' | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  // ✕ and swipe-to-dismiss are off while saving (FormChrome), but the screen
  // can still be torn down underneath (sign-out, station switch) — never pop
  // whatever is below then.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    void resolveDoc({ slug, id }).then((d) => {
      if (!alive) return;
      if (typeof d === 'string') {
        setDoc(d);
        return;
      }
      if (!canEditDoc(d)) {
        setDoc('readOnly');
        return;
      }
      setDoc(d);
      setTitle(d.title);
      setContent(d.content_markdown || '');
    });
    return () => {
      alive = false;
    };
  }, [slug, id, attempt]);

  const retry = useCallback(() => {
    setDoc(null);
    setAttempt((n) => n + 1);
  }, []);

  const loaded = doc !== null && typeof doc !== 'string' ? doc : null;
  const dirty = !!loaded && (title !== loaded.title || content !== (loaded.content_markdown || ''));
  const canSave = dirty && !!title.trim(); // dirty ⇒ loaded

  const cancel = useCallback(() => {
    Keyboard.dismiss();
    router.back();
  }, [router]);

  const save = useCallback(async () => {
    if (!loaded || !canSave || saving) return;
    Keyboard.dismiss();
    setSaving(true);
    const result = await updateDoc(loaded.id, {
      title: title.trim(),
      content_markdown: content,
      base_updated_at: loaded.updated_at ?? undefined,
    });
    if (!result) {
      // Failed: say so and keep the editor open with the edits intact.
      alertError(t('knowledge.saveFailed'));
      if (mounted.current) setSaving(false);
      return;
    }
    if (mounted.current) router.back();
    if (result.conflict) {
      // Saved, but over someone else's edit made since this editor loaded
      // (last write wins). That is not a plain confirmation — the other
      // person's change was just replaced, and the user should know it can be
      // brought back from 修改历史 — so it gets the system alert, not a toast
      // that vanishes as the modal closes. (RN alerts present in their own
      // window, so dismissing the modal underneath is fine.)
      alertError(t('knowledge.conflictSaved'), t('knowledge.conflictSavedHint'));
    } else {
      toast(t('knowledge.saved'), 'check');
    }
  }, [loaded, canSave, saving, title, content, router, t]);

  return (
    <>
      <FormChrome
        title={t('knowledge.editTitle')}
        dirty={dirty}
        canSave={canSave}
        saving={saving}
        onSave={() => void save()}
        onCancel={cancel}
      />
      {doc === null ? (
        <LoadingState />
      ) : doc === 'missing' ? (
        <View style={styles.center}>
          <EmptyState icon="book" title={t('knowledge.missing')} message={t('knowledge.missingHint')} />
        </View>
      ) : doc === 'readOnly' ? (
        <View style={styles.center}>
          <EmptyState icon="lock" title={t('knowledge.noEditAccess')} message={t('knowledge.noEditAccessHint')} />
        </View>
      ) : doc === 'failed' ? (
        <View style={styles.center}>
          <EmptyState
            icon="alert"
            title={t('knowledge.docFailed')}
            message={t('knowledge.loadFailedHint')}
            onRetry={retry}
          />
        </View>
      ) : (
        <KeyboardAwareScrollView
          contentInsetAdjustmentBehavior="automatic"
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          bottomOffset={space.xxl}
          contentContainerStyle={styles.content}
        >
          <TextInput
            value={title}
            onChangeText={setTitle}
            editable={!saving}
            placeholder={t('knowledge.titlePlaceholder')}
            placeholderTextColor={c.placeholder}
            selectionColor={c.accent}
            style={styles.title}
            multiline
            submitBehavior="submit"
            returnKeyType="next"
            onSubmitEditing={() => bodyRef.current?.focus()}
            accessibilityLabel={t('knowledge.fieldTitle')}
          />
          <View style={styles.hairline} />
          <TextInput
            ref={bodyRef}
            value={content}
            onChangeText={setContent}
            editable={!saving}
            placeholder={t('knowledge.contentPlaceholder')}
            placeholderTextColor={c.placeholder}
            selectionColor={c.accent}
            style={[styles.body, { minHeight: windowHeight * 0.6 }]}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            scrollEnabled={false}
            textAlignVertical="top"
            accessibilityLabel={t('knowledge.fieldContent')}
          />
        </KeyboardAwareScrollView>
      )}
    </>
  );
}

const useStyles = makeStyles((c) => ({
  center: { flex: 1, justifyContent: 'center' },
  content: { paddingHorizontal: space.margin, paddingTop: space.sm, paddingBottom: space.xxxl },
  title: { ...typo.title2, color: c.label, paddingVertical: space.sm },
  hairline: { height: StyleSheet.hairlineWidth, backgroundColor: c.separator, marginVertical: space.xs },
  body: { ...typo.body, color: c.label, paddingTop: space.sm },
}));
