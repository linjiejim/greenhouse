/**
 * Composer — the floating Liquid Glass control layer at the bottom of a conversation (iOS 26
 * Messages-style): one `GlassGroup` row of
 *
 *   [+]  [ glass capsule: skill · quote · files · growing text field ]  [↑ / ■]
 *
 * `+` opens a native menu: Camera, Photos, Files, and what the screen adds (`menuExtra`: @ in a
 * room, `/` skills). The field grows to ~6 lines then scrolls. Send and stop share one place
 * (docs/design-system/conversation.md): while an Agent answers, an empty composer offers stop,
 * and anything typed sends into the queue. Sending waits for every file to finish uploading.
 *
 * Pure view: the screen owns the draft, the files and keyboard placement (it wraps this in a
 * KeyboardStickyView) and gets the control layer's height through `onHeight` to pad the list.
 * `accessory` sits above the input row (the @ strip, the skill list, a skill's fields).
 */

import React, { forwardRef, memo } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, { FadeIn, LinearTransition } from 'react-native-reanimated';
import { useT } from '../lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon, Spinner, Touchable } from '../ui/core';
import { Glass, GlassGroup, GlassIconButton } from '../ui/glass';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
import { MAX_FILES, canSendMessage, type ComposerFile } from './composer-files';
import { fileIcon } from './file-card';
import type { AttachSource } from './use-composer-files';

/** Field height cap ≈ 6 lines of body text. */
const MAX_INPUT_HEIGHT = 6 * 22 + 22;
const ATTACH_IDS = new Set<string>(['camera', 'library', 'files']);

export const Composer = memo(
  forwardRef<
    TextInput,
    {
      value: string;
      onChangeText: (v: string) => void;
      onSend: () => void;
      /** An Agent answers here now: with nothing typed, the button stops it. */
      working?: boolean;
      onStop?: () => void;
      /** A send is on its way: the button waits. */
      sending?: boolean;
      onAttach: (from: AttachSource) => void;
      quote: string | null;
      onClearQuote: () => void;
      files: ComposerFile[];
      onRemoveFile: (id: string) => void;
      onRetryFiles: () => void;
      /** The skill chosen with `/` ("/weekly-report · Weekly report"). */
      skill?: string | null;
      onClearSkill?: () => void;
      placeholder: string;
      autoFocus?: boolean;
      /** Height of the control layer (excluding the bottom safe-area pad). */
      onHeight?: (h: number) => void;
      /** A row above the input row (the @ strip, the skill list or a skill's fields). */
      accessory?: React.ReactNode;
      /** The text field's selection (the caret) as it moves. */
      onSelectionChange?: (sel: { start: number; end: number }) => void;
      /** More `+` menu items, in their own section. */
      menuExtra?: { items: MenuItem[]; onSelect(id: string): void };
      /** Files can't be added now (editing a sent message): the `+` menu says why. */
      attachNote?: string;
    }
  >(function Composer(
    {
      value,
      onChangeText,
      onSend,
      working = false,
      onStop,
      sending = false,
      onAttach,
      quote,
      onClearQuote,
      files,
      onRemoveFile,
      onRetryFiles,
      skill,
      onClearSkill,
      placeholder,
      autoFocus = false,
      onHeight,
      accessory,
      onSelectionChange,
      menuExtra,
      attachNote,
    },
    ref,
  ) {
    const { colors: c } = useTheme();
    const styles = useStyles(c);
    const t = useT();
    const canSend = !sending && canSendMessage(value, files, !!skill);
    const failed = files.some((file) => file.status === 'error');
    const hasChips = files.length > 0 || !!quote || !!skill;
    const full = files.length >= MAX_FILES || !!attachNote;
    const showStop = working && !!onStop && !value.trim() && !files.length && !skill;
    const attachItems: MenuItem[] = [
      { id: 'camera', title: t('composer.camera'), icon: 'camera', disabled: full },
      { id: 'library', title: t('composer.photos'), icon: 'photos', disabled: full },
      { id: 'files', title: t('composer.files'), icon: 'attach', disabled: full },
    ];

    return (
      <View style={styles.wrap} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
        {accessory ? <View style={styles.accessory}>{accessory}</View> : null}

        <GlassGroup spacing={8} style={styles.row}>
          <NativeMenu
            title={attachNote ?? (files.length >= MAX_FILES ? t('composer.maxFiles', { n: MAX_FILES }) : undefined)}
            items={menuExtra ? menuSections([attachItems, menuExtra.items]) : attachItems}
            onSelect={(id) => {
              if (menuExtra && !ATTACH_IDS.has(id)) menuExtra.onSelect(id);
              else onAttach(id as AttachSource);
            }}
          >
            <GlassIconButton icon="plus" accessibilityLabel={t('composer.add')} />
          </NativeMenu>

          <Glass interactive style={styles.capsule}>
            {hasChips ? (
              <Animated.View layout={LinearTransition.duration(180)} style={styles.chips}>
                {skill ? (
                  <View style={styles.skill}>
                    <Icon name="wand" size={13} color={c.accent} />
                    <Text numberOfLines={1} style={styles.skillText}>
                      {skill}
                    </Text>
                    <Touchable
                      onPress={onClearSkill}
                      style={styles.chipRemove}
                      accessibilityRole="button"
                      accessibilityLabel={t('composer.clearSkill')}
                    >
                      <Icon name="x" size={12} weight="semibold" color={c.secondaryLabel} />
                    </Touchable>
                  </View>
                ) : null}
                {quote ? (
                  <View style={styles.quote}>
                    <View style={styles.quoteBar} />
                    <Text numberOfLines={2} style={styles.quoteText}>
                      {quote}
                    </Text>
                    <Touchable
                      onPress={onClearQuote}
                      style={styles.chipRemove}
                      accessibilityRole="button"
                      accessibilityLabel={t('composer.clearQuote')}
                    >
                      <Icon name="x" size={13} weight="semibold" color={c.secondaryLabel} />
                    </Touchable>
                  </View>
                ) : null}
                {files.length ? (
                  <ScrollView
                    horizontal
                    keyboardShouldPersistTaps="always"
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.thumbs}
                  >
                    {files.map((file) => (
                      <Animated.View
                        key={file.id}
                        entering={FadeIn.duration(180)}
                        style={file.kind === 'image' ? styles.thumb : styles.fileTile}
                      >
                        {file.kind === 'image' ? (
                          <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
                        ) : (
                          <View style={styles.fileInner}>
                            <Icon name={fileIcon(file.name)} size={16} color={c.secondaryLabel} />
                            <Text numberOfLines={2} ellipsizeMode="middle" style={styles.fileName}>
                              {file.name}
                            </Text>
                          </View>
                        )}
                        {file.status !== 'done' ? (
                          <View style={styles.thumbOverlay}>
                            {file.status === 'uploading' ? (
                              <Spinner />
                            ) : (
                              <Icon name="alert" size={18} weight="semibold" color={c.red} />
                            )}
                          </View>
                        ) : null}
                        <Touchable
                          onPress={() => onRemoveFile(file.id)}
                          style={styles.thumbX}
                          accessibilityRole="button"
                          accessibilityLabel={t('composer.removeFile', { name: file.name })}
                        >
                          <View style={styles.thumbXDot}>
                            <Icon name="x" size={9} weight="bold" color={c.background} />
                          </View>
                        </Touchable>
                      </Animated.View>
                    ))}
                  </ScrollView>
                ) : null}
                {failed ? (
                  <View style={styles.uploadError}>
                    <Text style={styles.uploadErrorText}>{t('composer.uploadFailed')}</Text>
                    <NativeButton label={t('common.retry')} size="small" onPress={onRetryFiles} />
                  </View>
                ) : null}
              </Animated.View>
            ) : null}
            <TextInput
              ref={ref}
              value={value}
              onChangeText={onChangeText}
              autoFocus={autoFocus}
              placeholder={placeholder}
              placeholderTextColor={c.placeholder}
              selectionColor={c.accent}
              multiline
              scrollEnabled
              style={styles.input}
              testID="composer-input"
              accessibilityLabel={placeholder}
              onSelectionChange={onSelectionChange ? (e) => onSelectionChange(e.nativeEvent.selection) : undefined}
            />
          </Glass>

          {showStop ? (
            <GlassIconButton icon="stop" prominent onPress={onStop} accessibilityLabel={t('composer.stop')} />
          ) : (
            <GlassIconButton
              icon="up"
              prominent
              disabled={!canSend}
              onPress={onSend}
              accessibilityLabel={t('composer.send')}
            />
          )}
        </GlassGroup>
      </View>
    );
  }),
);

/** In place of the composer where nobody can write: why, and the one way out. */
export function ReadOnlyBar({
  onHeight,
  message,
  action,
}: {
  onHeight?: (h: number) => void;
  message: string;
  action?: { label: string; onPress(): void };
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.wrap} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
      <Glass style={styles.readOnly}>
        <Text style={styles.readOnlyText}>{message}</Text>
        {action ? <NativeButton label={action.label} size="small" onPress={action.onPress} /> : null}
      </Glass>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { paddingHorizontal: space.md, paddingTop: space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  capsule: { flex: 1, minHeight: 44, borderRadius: 22, justifyContent: 'center', overflow: 'hidden' },
  input: {
    fontSize: typo.body.fontSize,
    color: c.label,
    paddingHorizontal: space.lg,
    paddingTop: 11,
    paddingBottom: 11,
    maxHeight: MAX_INPUT_HEIGHT,
  },
  chips: { paddingTop: space.sm, paddingHorizontal: space.sm, gap: space.xs + 2 },
  thumbs: { gap: space.sm, paddingRight: space.xs },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  fileTile: {
    width: 112,
    height: 60,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  fileInner: { flex: 1, padding: space.sm, gap: 2 },
  fileName: { ...typo.caption2, color: c.label },
  thumbOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.background,
    opacity: 0.7,
  },
  thumbX: { position: 'absolute', top: 0, right: 0, width: HIT, height: HIT, alignItems: 'flex-end', padding: 4 },
  // label-on-background inverts per scheme: dark dot + light ✕ in light mode, and vice versa
  thumbXDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.label,
    opacity: 0.72,
  },
  uploadError: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingLeft: space.xs, gap: space.xs },
  uploadErrorText: { ...typo.footnote, color: c.red, flexShrink: 1 },
  skill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    maxWidth: '100%',
    paddingLeft: space.sm,
    borderRadius: radius.full,
    backgroundColor: c.accentFill,
  },
  skillText: { flexShrink: 1, ...typo.footnote, color: c.accent },
  quote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs + 2,
    paddingLeft: space.xs + 2,
    borderRadius: radius.md,
    backgroundColor: c.quaternaryFill,
    ...squircle,
  },
  quoteBar: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: c.accent },
  quoteText: { flex: 1, ...typo.footnote, color: c.secondaryLabel },
  chipRemove: { width: 36, minHeight: 32, alignItems: 'center', justifyContent: 'center' },
  // grows with Dynamic Type (the message may wrap; the action sits beside it)
  readOnly: {
    minHeight: 44,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  readOnlyText: { flexShrink: 1, ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  accessory: { paddingBottom: space.sm },
}));
