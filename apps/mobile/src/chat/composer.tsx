/**
 * Composer — the floating Liquid Glass control layer at the bottom of home and a conversation
 * (ported from the v2 app, src/chat/composer.tsx there):
 *
 *   [+]  [ glass capsule: picked files · growing text field ]  [mic]  [↑ / ■]
 *
 *  - `+` opens a native menu: Photos, Camera, Files. Files upload as soon as they are picked
 *    (./use-composer-files.ts) and retry in place; send waits until every one is up.
 *  - mic: hold to talk (on-device recognition, src/voice/use-dictation.ts): what is heard shows
 *    live above the row; lift to send it (after anything typed), slide up and lift to cancel.
 *  - ↑ sends; while the assistant answers, an empty composer offers ■ (stop) instead.
 *
 * Pure view apart from dictation: the screen owns the draft and the files and places it (a
 * KeyboardStickyView), and learns its height through `onHeight` to pad its list.
 */

import React, { forwardRef, memo, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions, type GestureResponderEvent } from 'react-native';
import { Image } from 'expo-image';
import Animated, { FadeIn, FadeOut, ReduceMotion } from 'react-native-reanimated';
import { useT } from '../lib/i18n';
import { HIT, makeStyles, motion, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon, Spinner, Touchable } from '../ui/core';
import { FileIcon } from '../ui/file-icon';
import { Glass, GlassGroup, GlassIconButton } from '../ui/glass';
import { selectionTick, tapMedium } from '../ui/haptics';
import { NativeMenu, type MenuItem } from '../ui/menu';
import { cancelArmed, dictatedMessage } from '../voice/dictation';
import { useDictation } from '../voice/use-dictation';
import { MAX_FILES, canSendMessage, type ComposerFile } from './composer-files';
import type { AttachSource } from './use-composer-files';

export const Composer = memo(
  forwardRef<
    TextInput,
    {
      value: string;
      onChangeText: (v: string) => void;
      /** Send the draft (or, after dictation, these words). */
      onSend: (text?: string) => void;
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
    { value, onChangeText, onSend, working = false, onStop, onAttach, files, onRemoveFile, onRetryFiles, placeholder, autoFocus, onHeight },
    ref,
  ) {
    const { colors: c } = useTheme();
    const styles = useStyles(c);
    const t = useT();
    const { fontScale, height } = useWindowDimensions();
    const minInputHeight = Math.max(HIT, Math.ceil(typo.body.lineHeight * fontScale) + space.md * 2);
    const maxInputHeight = Math.max(minInputHeight, Math.min(6 * typo.body.lineHeight * fontScale + space.md * 2, height * 0.4));
    const [inputHeight, setInputHeight] = useState(0);
    useEffect(() => setInputHeight(0), [fontScale]);

    const dictation = useDictation();
    const [armed, setArmed] = useState(false);
    const startY = useRef(0);
    const holding = useRef(false);
    const listening = dictation.state !== 'idle';

    const canSend = !listening && canSendMessage(value, files);
    const failed = files.some((file) => file.status === 'error');
    const full = files.length >= MAX_FILES;
    const showStop = working && !!onStop && !value.trim() && !files.length && !listening;
    const attachItems: MenuItem[] = [
      { id: 'library', title: t('composer.photos'), icon: 'photos', disabled: full },
      { id: 'camera', title: t('composer.camera'), icon: 'camera', disabled: full },
      { id: 'files', title: t('composer.files'), icon: 'attach', disabled: full },
    ];

    const holdStart = (e: GestureResponderEvent) => {
      holding.current = true;
      startY.current = e.nativeEvent.pageY;
      setArmed(false);
      tapMedium();
      void dictation.begin().then((ok) => {
        // the finger lifted before the permission answer: nothing to listen for
        if (ok && !holding.current) dictation.cancel();
      });
    };
    const holdMove = (e: GestureResponderEvent) => {
      const next = cancelArmed(e.nativeEvent.pageY - startY.current);
      if (next !== armed) {
        selectionTick();
        setArmed(next);
      }
    };
    const holdEnd = async (cancelled: boolean) => {
      holding.current = false;
      setArmed(false);
      if (cancelled) {
        dictation.cancel();
        return;
      }
      const heard = await dictation.finish();
      const message = dictatedMessage(value, heard);
      if (message) onSend(message);
    };

    return (
      <View style={styles.wrap} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
        {listening ? (
          <Animated.View
            entering={FadeIn.duration(motion.fast).reduceMotion(ReduceMotion.System)}
            exiting={FadeOut.duration(motion.fast).reduceMotion(ReduceMotion.System)}
          >
            <Glass style={[styles.listen, armed && styles.listenArmed]}>
              <View style={styles.listenHead}>
                <Icon name={armed ? 'x' : 'mic'} size={15} weight="semibold" color={armed ? c.red : c.accent} />
                <Text style={[styles.listenHint, armed && { color: c.red }]}>
                  {armed ? t('voice.releaseToCancel') : t('voice.releaseToSend')}
                </Text>
              </View>
              <Text style={styles.listenText} accessibilityLiveRegion="polite">
                {dictation.heard || t('voice.listening')}
              </Text>
            </Glass>
          </Animated.View>
        ) : null}

        <GlassGroup spacing={space.sm} style={styles.row}>
          <NativeMenu
            title={full ? t('composer.maxFiles', { n: MAX_FILES }) : undefined}
            items={attachItems}
            onSelect={(id) => onAttach(id as AttachSource)}
          >
            <GlassIconButton icon="plus" accessibilityLabel={t('composer.add')} />
          </NativeMenu>

          <Glass interactive style={styles.capsule}>
            {files.length ? (
              <View style={styles.chips}>
                <ScrollView horizontal keyboardShouldPersistTaps="always" showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
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
                          {file.status === 'uploading' ? <Spinner /> : <Icon name="alert" size={18} weight="semibold" color={c.red} />}
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
              style={[
                styles.input,
                {
                  minHeight: minInputHeight,
                  maxHeight: maxInputHeight,
                  height: Math.max(minInputHeight, Math.min(maxInputHeight, value ? inputHeight : minInputHeight)),
                },
              ]}
              onContentSizeChange={(event) => setInputHeight(event.nativeEvent.contentSize.height)}
              accessibilityLabel={placeholder}
              testID="composer-input"
            />
          </Glass>

          {/* hold to talk: a raw responder, so the finger can slide up to cancel */}
          <View
            onStartShouldSetResponder={() => true}
            onResponderGrant={holdStart}
            onResponderMove={holdMove}
            onResponderRelease={() => void holdEnd(armed)}
            onResponderTerminate={() => void holdEnd(true)}
            accessible
            accessibilityRole="button"
            accessibilityLabel={t('voice.hold')}
            accessibilityHint={t('voice.holdHint')}
          >
            <Glass interactive tint={listening ? c.accentFill : undefined} style={styles.mic}>
              <Icon name="mic" size={18} weight="semibold" color={listening ? c.accent : c.label} />
            </Glass>
          </View>

          {showStop ? (
            <GlassIconButton icon="stop" prominent onPress={onStop} accessibilityLabel={t('composer.stop')} />
          ) : (
            <GlassIconButton icon="up" prominent disabled={!canSend} onPress={() => onSend()} accessibilityLabel={t('composer.send')} />
          )}
        </GlassGroup>
      </View>
    );
  }),
);

const useStyles = makeStyles((c) => ({
  wrap: { paddingHorizontal: space.md, paddingTop: space.sm, gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  capsule: { flex: 1, minHeight: HIT, borderRadius: HIT / 2, justifyContent: 'center', overflow: 'hidden' },
  input: { ...typo.body, color: c.label, paddingHorizontal: space.lg, paddingVertical: space.md },
  mic: { width: HIT, height: HIT, borderRadius: HIT / 2, alignItems: 'center', justifyContent: 'center' },
  chips: { paddingTop: space.sm, paddingHorizontal: space.sm, gap: space.xs },
  thumbs: { gap: space.sm, paddingRight: space.xs },
  thumb: { width: 60, height: 60, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.tertiaryFill, ...squircle },
  fileTile: { width: 112, height: 60, borderRadius: radius.md, overflow: 'hidden', backgroundColor: c.tertiaryFill, ...squircle },
  fileInner: { flex: 1, padding: space.sm, gap: space.xxs },
  fileName: { ...typo.caption2, color: c.label },
  thumbOverlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: c.background, opacity: 0.7 },
  thumbX: { position: 'absolute', top: 0, right: 0, width: HIT, height: HIT, alignItems: 'flex-end', padding: space.xs },
  // label-on-background inverts per scheme: a dark dot with a light ✕ in light mode, and vice versa
  thumbXDot: { width: 20, height: 20, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: c.label, opacity: 0.72 },
  uploadError: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', paddingLeft: space.xs, gap: space.xs },
  uploadErrorText: { ...typo.footnote, color: c.red, flexShrink: 1 },
  listen: { borderRadius: radius.lg, padding: space.md, gap: space.xs },
  listenArmed: { borderWidth: 1, borderColor: c.red },
  listenHead: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  listenHint: { ...typo.footnote, fontWeight: weight.semibold, color: c.accent },
  listenText: { ...typo.body, color: c.label },
}));
