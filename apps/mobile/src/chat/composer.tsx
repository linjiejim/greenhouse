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
 *
 * The Bots thread adds optional pieces (none given = the conversation's
 * composer, unchanged):
 *  - `stop` — a separate Stop between the capsule and Send while a run is
 *    live, so sending stays possible (Send never turns into Stop and never
 *    moves; the capsule narrows as Stop slides in): tap = the caller's
 *    `onPress` (soft, then hard), long press = a system menu of the two;
 *    while a hard stop winds down it's a disabled spinner;
 *  - `accessory` — a row above the input row (the task dock, the @-mention
 *    strip);
 *  - `onSelectionChange` — the caret (the mention picker reads the token
 *    before it);
 *  - `menuExtra` — more items in the `+` menu (a group's "Mention ▸").
 */

import React, { forwardRef, memo, useEffect, useMemo, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useT } from '../lib/i18n';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme } from '../theme';
import { NativeButton } from '../ui/button';
import { Icon, Spinner, Touchable } from '../ui/core';
import { Glass, GlassGroup, GlassIconButton, LIQUID_GLASS } from '../ui/glass';
import { NativeMenu, menuSections, type MenuItem } from '../ui/menu';
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

/**
 * The Bots composer's Stop (a run is live). `phase`: `running` — tap asks for
 * a soft stop (finish this step); `soft` — asked, tap again to stop now;
 * `hard` — stopping now (disabled spinner). Haptics are the caller's (it
 * knows which stop a tap became).
 */
export interface ComposerStop {
  phase: 'running' | 'soft' | 'hard';
  onPress(): void;
  /** The long-press menu's pick. */
  onMenu(choice: 'soft' | 'hard'): void;
  /** Says what a tap does in this phase. */
  accessibilityLabel: string;
  menuLabels: { soft: string; hard: string };
}

/** Field height cap ≈ 6 lines of body text. */
const MAX_INPUT_HEIGHT = 6 * 22 + 22;
/** The `+` menu's own item ids (`menuExtra` items must use others). */
const ATTACH_IDS = new Set(['camera', 'library']);
/** The Stop slot: the button plus the row gap it brings along. */
const STOP_SLOT = HIT + space.sm;
const STOP_MS = 180;
const PRESSED_DIM = { opacity: 0.6 };

/**
 * Stop, between the capsule and Send. Once a stop has been offered the slot
 * stays mounted and animates its width (0 ↔ button + gap), so the capsule
 * narrows / widens smoothly and Send never moves; the last stop is kept
 * on screen while it slides out.
 */
const StopSlot = memo(function StopSlot({ stop }: { stop?: ComposerStop }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const reduceMotion = useReducedMotion();
  const last = useRef(stop);
  if (stop) last.current = stop;
  const shown = stop ?? last.current;
  const live = !!stop;
  const open = useSharedValue(0);
  useEffect(() => {
    open.value = reduceMotion ? (live ? 1 : 0) : withTiming(live ? 1 : 0, { duration: STOP_MS });
  }, [live, open, reduceMotion]);
  const slide = useAnimatedStyle(() => ({ width: open.value * STOP_SLOT, opacity: open.value }));
  const phase = shown?.phase;
  const soft = shown?.menuLabels.soft ?? '';
  const hard = shown?.menuLabels.hard ?? '';
  const items = useMemo<MenuItem[]>(() => {
    const now: MenuItem = { id: 'hard', title: hard, icon: 'stop', destructive: true };
    return phase === 'running' ? [{ id: 'soft', title: soft, icon: 'stopCircle' }, now] : [now];
  }, [phase, soft, hard]);
  if (!shown) return null;
  return (
    <Animated.View
      style={[styles.stopSlot, slide]}
      pointerEvents={live ? 'auto' : 'none'}
      accessibilityElementsHidden={!live}
      importantForAccessibility={live ? 'auto' : 'no-hide-descendants'}
    >
      {shown.phase === 'hard' ? (
        <View
          accessible
          accessibilityRole="button"
          accessibilityState={{ disabled: true, busy: true }}
          accessibilityLabel={shown.accessibilityLabel}
        >
          <Glass style={styles.stopButton}>
            <Spinner />
          </Glass>
        </View>
      ) : (
        <NativeMenu
          trigger="longPress"
          fill={false}
          items={items}
          onSelect={(id) => shown.onMenu(id === 'soft' ? 'soft' : 'hard')}
        >
          <Touchable
            onPress={shown.onPress}
            // interactive glass answers the touch itself (as GlassIconButton)
            pressedStyle={LIQUID_GLASS ? {} : PRESSED_DIM}
            accessibilityRole="button"
            accessibilityLabel={shown.accessibilityLabel}
          >
            <Glass interactive style={styles.stopButton}>
              <Icon
                name={shown.phase === 'soft' ? 'stopCircle' : 'stop'}
                size={Math.round(HIT * 0.42)}
                weight="semibold"
                color={c.label}
                // asked to stop: the symbol pulses until the run winds down
                animationSpec={
                  shown.phase === 'soft' && !reduceMotion ? { effect: { type: 'pulse' }, repeating: true } : undefined
                }
              />
            </Glass>
          </Touchable>
        </NativeMenu>
      )}
    </Animated.View>
  );
});

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
      /** A Stop beside Send while a run is live (Bots); given → `streaming` / `onStop` are ignored. */
      stop?: ComposerStop;
      /** A row above the input row (Bots: the task dock or the @-mention strip). */
      accessory?: React.ReactNode;
      /** The text field's selection (the caret) as it moves. */
      onSelectionChange?: (sel: { start: number; end: number }) => void;
      /** More `+` menu items, in their own section (ids other than `camera` / `library`). */
      menuExtra?: { items: MenuItem[]; onSelect(id: string): void };
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
      stop,
      accessory,
      onSelectionChange,
      menuExtra,
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
    // A separate Stop takes over from the in-place one (Send stays Send).
    const stopInPlace = streaming && !stop;
    // Mounted from the first stop on, so it can slide in and out.
    const [stopSeen, setStopSeen] = useState(false);
    if (stop && !stopSeen) setStopSeen(true);
    const attachItems: MenuItem[] = [
      { id: 'camera', title: t('chat.attachCamera'), icon: 'camera', disabled: full },
      { id: 'library', title: t('chat.attachPhotos'), icon: 'photos', disabled: full },
    ];

    return (
      <View style={styles.wrap} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
        {pickAgent ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(150)} style={styles.profileRow}>
            <ProfileMenu />
          </Animated.View>
        ) : null}
        {accessory ? <View style={styles.accessory}>{accessory}</View> : null}

        <GlassGroup spacing={8} style={styles.row}>
          <NativeMenu
            title={full ? t('chat.maxImages', { n: maxImages }) : undefined}
            items={menuExtra ? menuSections([attachItems, menuExtra.items]) : attachItems}
            onSelect={(id) => {
              if (menuExtra && !ATTACH_IDS.has(id)) menuExtra.onSelect(id);
              else onAttach(id === 'camera' ? 'camera' : 'library');
            }}
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
              onSelectionChange={onSelectionChange ? (e) => onSelectionChange(e.nativeEvent.selection) : undefined}
            />
          </Glass>

          {stopSeen ? <StopSlot stop={stop} /> : null}
          {stopInPlace ? (
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

/**
 * The quiet bar that replaces the composer in a shared (read-only)
 * conversation — or, with a `message` (and optionally an `action`), wherever
 * nobody can be written to (a Bots thread whose Bot is archived, a group
 * with no one left to reply).
 */
export function ReadOnlyBar({
  onHeight,
  message,
  action,
}: {
  onHeight?: (h: number) => void;
  /** Says why there is no composer (default: shared · read-only). */
  message?: string;
  /** One way out, beside the message (e.g. "Invite a Bot"). */
  action?: { label: string; onPress(): void };
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <View style={styles.wrap} onLayout={(e) => onHeight?.(e.nativeEvent.layout.height)}>
      {message == null ? (
        <Glass style={styles.readOnly}>
          {/* one VoiceOver element: "Shared · read-only" */}
          <View accessible accessibilityLabel={t('chat.sharedReadOnly')} style={styles.readOnlyInner}>
            <Icon name="users" size={15} color={c.secondaryLabel} />
            <Text style={styles.readOnlyText}>{t('chat.sharedReadOnly')}</Text>
          </View>
        </Glass>
      ) : (
        <Glass style={styles.readOnlyNote}>
          <Text style={styles.readOnlyNoteText}>{message}</Text>
          {action ? <NativeButton label={action.label} size="small" onPress={action.onPress} /> : null}
        </Glass>
      )}
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
  // grows with Dynamic Type (the message may wrap; the action sits beside it)
  readOnlyNote: {
    minHeight: 44,
    borderRadius: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
  },
  readOnlyNoteText: { flexShrink: 1, ...typo.subheadline, color: c.secondaryLabel, textAlign: 'center' },
  accessory: { paddingBottom: space.sm },
  stopSlot: {
    // the slot carries its own share of the row gap, so at width 0 it takes no room at all
    marginLeft: -space.sm,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    overflow: 'hidden',
  },
  stopButton: { width: HIT, height: HIT, borderRadius: HIT / 2, alignItems: 'center', justifyContent: 'center' },
}));
