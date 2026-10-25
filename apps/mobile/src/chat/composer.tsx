/**
 * Composer — the floating Liquid Glass control layer at the bottom of home and a conversation:
 * one rounded field that holds everything,
 *
 *   ( +  picked files · growing text field  ↑ / ■ )
 *
 *  - `+` opens a native menu: Photos, Camera, Files. Files upload as soon as they are picked
 *    (./use-composer-files.ts) and retry in place; send waits until every one is up.
 *  - ↑ sends, and is dimmed and disabled while there is nothing to send; while the assistant
 *    answers, an empty composer offers ■ (stop) instead.
 *  - The field grows with the text up to six lines and shrinks back as it empties.
 *
 * There is no voice input: members use the keyboard's own dictation. Pure view: the screen owns
 * the draft and the files and places it (a KeyboardStickyView), and learns its height through
 * `onHeight` to pad its list.
 */

import React, { forwardRef, memo } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from 'react-native';
import { Image } from 'expo-image';
import { useT } from '../lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon, Spinner, Touchable } from '../ui/core';
import { FileIcon } from '../ui/file-icon';
import { Glass } from '../ui/glass';
import { NativeMenu, type MenuItem } from '../ui/menu';
import { MAX_FILES, canSendMessage, type ComposerFile } from './composer-files';
import type { AttachSource } from './use-composer-files';

/** The round buttons inside the field (+, send, stop). */
const BUTTON = 32;
/** The space around them, so a one-line field is exactly HIT tall. */
const INSET = (HIT - BUTTON) / 2;

export const Composer = memo(
  forwardRef<
    TextInput,
    {
      value: string;
      onChangeText: (v: string) => void;
      /** Send the draft. */
      onSend: () => void;
      /** The assistant is answering: with nothing typed, the button stops it. */
      working?: boolean;
      onStop?: () => void;
      onAttach: (from: AttachSource) => void;
      files: ComposerFile[];
      onRemoveFile: (id: string) => void;
      onRetryFiles: () => void;
      placeholder: string;
      autoFocus?: boolean;
      /** Height of the control layer (excluding the bottom safe-area pad). */
      onHeight?: (h: number) => void;
    }
  >(function Composer(
    {
      value,
      onChangeText,
      onSend,
      working = false,
      onStop,
      onAttach,
      files,
      onRemoveFile,
      onRetryFiles,
      placeholder,
      autoFocus,
      onHeight,
    },
    ref,
  ) {
    const { colors: c } = useTheme();
    const styles = useStyles(c);
    const t = useT();
    const { fontScale, height } = useWindowDimensions();
    const lineHeight = typo.body.lineHeight * fontScale;
    // the field sizes itself to its text (iOS multiline): one line is HIT tall, at most six lines
    const minInputHeight = Math.max(HIT, Math.ceil(lineHeight) + space.sm * 2);
    const maxInputHeight = Math.max(minInputHeight, Math.min(6 * lineHeight + space.sm * 2, height * 0.4));

    const canSend = canSendMessage(value, files);
    const failed = files.some((file) => file.status === 'error');
    const full = files.length >= MAX_FILES;
    const showStop = working && !!onStop && !value.trim() && !files.length;
    const attachItems: MenuItem[] = [
      { id: 'library', title: t('composer.photos'), icon: 'photos', disabled: full },
      { id: 'camera', title: t('composer.camera'), icon: 'camera', disabled: full },
      { id: 'files', title: t('composer.files'), icon: 'attach', disabled: full },
    ];

    return (
      <View style={styles.wrap} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
        <Glass interactive style={styles.field}>
          {files.length ? (
            <View style={styles.chips}>
              <ScrollView
                horizontal
                keyboardShouldPersistTaps="always"
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.thumbs}
              >
                {files.map((file) => (
                  <View key={file.id} style={file.kind === 'image' ? styles.thumb : styles.fileTile}>
                    {file.kind === 'image' ? (
                      <Image source={{ uri: file.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
                    ) : (
                      <View style={styles.fileInner}>
                        <FileIcon name={file.name} contentType={file.mimeType} size={15} />
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
                  </View>
                ))}
              </ScrollView>
              {failed ? (
                <View style={styles.uploadError}>
                  <Text style={styles.uploadErrorText}>{t('composer.uploadFailed')}</Text>
                  <NativeButton label={t('common.retry')} size="small" onPress={onRetryFiles} />
                </View>
              ) : null}
            </View>
          ) : null}
          <View style={styles.row}>
            <NativeMenu
              title={full ? t('composer.maxFiles', { n: MAX_FILES }) : undefined}
              items={attachItems}
              onSelect={(id) => onAttach(id as AttachSource)}
            >
              <View style={styles.slot} accessible accessibilityRole="button" accessibilityLabel={t('composer.add')}>
                <View style={styles.plus}>
                  <Icon name="plus" size={18} weight="semibold" color={c.label} />
                </View>
              </View>
            </NativeMenu>
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
              style={[styles.input, { minHeight: minInputHeight, maxHeight: maxInputHeight }]}
              accessibilityLabel={placeholder}
              testID="composer-input"
            />
            {showStop ? (
              <Touchable
                onPress={onStop}
                haptic="light"
                style={styles.slot}
                accessibilityRole="button"
                accessibilityLabel={t('composer.stop')}
              >
                <View style={[styles.send, styles.sendOn]}>
                  <Icon name="stop" size={13} weight="bold" color={c.onAccent} />
                </View>
              </Touchable>
            ) : (
              <Touchable
                onPress={() => onSend()}
                disabled={!canSend}
                haptic="light"
                style={styles.slot}
                accessibilityRole="button"
                accessibilityLabel={t('composer.send')}
                accessibilityState={{ disabled: !canSend }}
              >
                <View style={[styles.send, canSend ? styles.sendOn : styles.sendOff]}>
                  <Icon name="up" size={16} weight="bold" color={canSend ? c.onAccent : c.tertiaryLabel} />
                </View>
              </Touchable>
            )}
          </View>
        </Glass>
      </View>
    );
  }),
);

const useStyles = makeStyles((c) => ({
  wrap: { paddingHorizontal: space.md, paddingTop: space.sm },
  field: { minHeight: HIT, borderRadius: HIT / 2, overflow: 'hidden', ...squircle },
  row: { flexDirection: 'row', alignItems: 'flex-end' },
  slot: { width: BUTTON + INSET * 2, height: HIT, alignItems: 'center', justifyContent: 'center' },
  plus: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: 'center', justifyContent: 'center' },
  send: { width: BUTTON, height: BUTTON, borderRadius: BUTTON / 2, alignItems: 'center', justifyContent: 'center' },
  sendOn: { backgroundColor: c.accent },
  sendOff: { backgroundColor: c.tertiaryFill },
  input: {
    ...typo.body,
    flex: 1,
    color: c.label,
    paddingHorizontal: space.xxs,
    paddingTop: space.sm + space.xxs,
    paddingBottom: space.sm + space.xxs,
  },
  chips: { paddingTop: space.sm, paddingHorizontal: space.sm, gap: space.xs },
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
  fileInner: { flex: 1, padding: space.sm, gap: space.xxs },
  fileName: { ...typo.caption2, color: c.label },
  thumbOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.background,
    opacity: 0.7,
  },
  thumbX: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: HIT,
    height: HIT,
    alignItems: 'flex-end',
    padding: space.xs,
  },
  // label-on-background inverts per scheme: a dark dot with a light ✕ in light mode, and vice versa
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
}));
