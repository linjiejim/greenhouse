/**
 * Composer — the floating Liquid Glass control layer at the bottom of the
 * conversation (iOS 26 Messages-style): one `GlassGroup` row of
 *
 *   [+]  [ glass capsule: attachments · quote chips · growing text field ]  [↑ / ■]
 *
 * `+` opens a native menu (拍照 / 照片图库 — images only, the upload API
 * rejects other types); the field grows to ~6 lines then scrolls; the send
 * button is the accent-tinted glass button and turns into stop while a reply
 * streams. For a new conversation an agent-profile capsule (ProfileMenu) sits
 * above the row — only when there is more than one agent to pick. Pure view:
 * the screen owns the draft, attachments and keyboard placement (it wraps this
 * in a KeyboardStickyView) and gets the control layer's height through
 * `onHeight` to pad the message list.
 */

import React, { forwardRef, memo } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useT } from '../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { Icon, Spinner, Touchable } from '../ui/core';
import { Glass, GlassGroup, GlassIconButton } from '../ui/glass';
import { NativeMenu } from '../ui/menu';
import type { Annotation } from './model';
import { ProfileMenu, useProfiles } from './profile-menu';

/** A picked image being uploaded (or uploaded) before send. */
export interface ComposerImage {
  id: string;
  /** Local (picker) uri for the thumbnail preview. */
  uri: string;
  status: 'uploading' | 'done' | 'error';
  remote?: { id: string; url: string };
}

/** Field height cap ≈ 6 lines of body text. */
const MAX_INPUT_HEIGHT = 6 * 22 + 22;

export const Composer = memo(
  forwardRef<
    TextInput,
    {
      value: string;
      onChangeText: (v: string) => void;
      onSend: () => void;
      streaming?: boolean;
      onStop?: () => void;
      onAttach: (from: 'camera' | 'library') => void;
      annotations: Annotation[];
      onRemoveAnnotation: (id: string) => void;
      images: ComposerImage[];
      onRemoveImage: (id: string) => void;
      /** Image cap per message — at the cap the `+` menu explains it and disables its items. */
      maxImages?: number;
      placeholder: string;
      /** Offer the agent-profile capsule (new conversations; shown only with a choice of agents). */
      showProfile?: boolean;
      autoFocus?: boolean;
      /** Height of the control layer (excluding the bottom safe-area pad). */
      onHeight?: (h: number) => void;
    }
  >(function Composer(
    {
      value,
      onChangeText,
      onSend,
      streaming = false,
      onStop,
      onAttach,
      annotations,
      onRemoveAnnotation,
      images,
      onRemoveImage,
      maxImages = Infinity,
      placeholder,
      showProfile = false,
      autoFocus = false,
      onHeight,
    },
    ref,
  ) {
    const { colors: c } = useTheme();
    const styles = useStyles(c);
    const t = useT();
    // Not while a picked image is still uploading — it would be left out of the message.
    const uploading = images.some((im) => im.status === 'uploading');
    const canSend = !uploading && (value.trim().length > 0 || images.some((im) => im.status === 'done'));
    const hasAttachments = images.length > 0 || annotations.length > 0;
    const full = images.length >= maxImages;
    // A single agent is no choice — no capsule (and no empty row) for it.
    const agents = useProfiles();
    const pickAgent = showProfile && (agents?.length ?? 0) > 1;

    return (
      <View style={styles.wrap} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
        {pickAgent ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={styles.profileRow}>
            <ProfileMenu />
          </Animated.View>
        ) : null}

        <GlassGroup spacing={8} style={styles.row}>
          <NativeMenu
            title={full ? t('chat.maxImages', { n: maxImages }) : undefined}
            items={[
              { id: 'camera', title: t('chat.attachCamera'), icon: 'camera', disabled: full },
              { id: 'library', title: t('chat.attachPhotos'), icon: 'photos', disabled: full },
            ]}
            onSelect={(id) => onAttach(id === 'camera' ? 'camera' : 'library')}
          >
            <GlassIconButton icon="plus" accessibilityLabel={t('chat.attachTitle')} />
          </NativeMenu>

          <Glass interactive style={styles.capsule}>
            {hasAttachments ? (
              <Animated.View layout={LinearTransition.duration(180)} style={styles.attachments}>
                {images.length ? (
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.thumbs}>
                    {images.map((im) => (
                      <Animated.View key={im.id} entering={FadeIn.duration(180)} style={styles.thumb}>
                        <Image source={{ uri: im.uri }} style={StyleSheet.absoluteFill} contentFit="cover" />
                        {im.status !== 'done' ? (
                          <View style={styles.thumbOverlay}>
                            {im.status === 'uploading' ? (
                              <Spinner />
                            ) : (
                              <Icon name="alert" size={18} weight="semibold" color={c.red} />
                            )}
                          </View>
                        ) : null}
                        <Touchable
                          onPress={() => onRemoveImage(im.id)}
                          hitSlop={8}
                          style={styles.thumbX}
                          accessibilityRole="button"
                          accessibilityLabel={t('chat.removeAttachment')}
                        >
                          <View style={styles.thumbXDot}>
                            <Icon name="x" size={9} weight="bold" color={c.background} />
                          </View>
                        </Touchable>
                      </Animated.View>
                    ))}
                  </ScrollView>
                ) : null}
                {annotations.map((a) => (
                  <View key={a.id} style={styles.quote}>
                    <View style={styles.quoteBar} />
                    <Text numberOfLines={2} style={styles.quoteText}>
                      {a.text}
                    </Text>
                    <Touchable
                      onPress={() => onRemoveAnnotation(a.id)}
                      hitSlop={10}
                      accessibilityRole="button"
                      accessibilityLabel={t('chat.removeAttachment')}
                    >
                      <Icon name="x" size={13} weight="semibold" color={c.secondaryLabel} />
                    </Touchable>
                  </View>
                ))}
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
            />
          </Glass>

          {streaming ? (
            <GlassIconButton icon="stop" prominent onPress={onStop} accessibilityLabel={t('chat.stop')} />
          ) : (
            <GlassIconButton
              icon="up"
              prominent
              disabled={!canSend}
              onPress={onSend}
              accessibilityLabel={t('chat.send')}
            />
          )}
        </GlassGroup>
      </View>
    );
  }),
);

/** The quiet bar that replaces the composer in a shared (read-only) conversation. */
export function ReadOnlyBar({ onHeight }: { onHeight?: (h: number) => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.wrap} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
      <Glass style={styles.readOnly}>
        {/* one VoiceOver element: "Shared · read-only" */}
        <View accessible accessibilityLabel={t('chat.sharedReadOnly')} style={styles.readOnlyInner}>
          <Icon name="users" size={15} color={c.secondaryLabel} />
          <Text style={styles.readOnlyText}>{t('chat.sharedReadOnly')}</Text>
        </View>
      </Glass>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { paddingHorizontal: space.md, paddingTop: space.sm },
  profileRow: { flexDirection: 'row', paddingLeft: 44 + space.sm, paddingBottom: space.sm },
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
  attachments: { paddingTop: space.sm, paddingHorizontal: space.sm, gap: space.xs + 2 },
  thumbs: { gap: space.sm, paddingRight: space.xs },
  thumb: {
    width: 60,
    height: 60,
    borderRadius: radius.md,
    overflow: 'hidden',
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  thumbOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.background,
    opacity: 0.7,
  },
  thumbX: { position: 'absolute', top: 4, right: 4 },
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
  quote: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs + 2,
    paddingLeft: space.xs + 2,
    paddingRight: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: c.quaternaryFill,
    ...squircle,
  },
  quoteBar: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: c.accent },
  quoteText: { flex: 1, ...typo.footnote, color: c.secondaryLabel },
  readOnly: { height: 44, borderRadius: 22, justifyContent: 'center' },
  readOnlyInner: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm },
  readOnlyText: { ...typo.subheadline, color: c.secondaryLabel },
}));
