/**
 * Composer — the full-width flat input bar (Home hero + Chat bottom). Auto-
 * growing multiline input with the "+" (attach) on its left and, once focused, a
 * fullscreen-expand button on its right that opens an immersive editor modal.
 * Below: the primary send button (→ danger stop while streaming). Optional
 * annotation ("引用追问") and image-preview strips. (Voice input hidden for now.)
 */

import React, { useState } from 'react';
import { Image, Modal, StyleSheet, Text, TextInput, View, type ViewStyle } from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useT } from '../lib/i18n';
import { useBottomPadStyle } from '../lib/keyboard';
import { makeStyles, shadow, useTheme } from '../theme';
import { Icon, Spinner, Touchable } from '../ui';

export interface Annotation {
  id: string;
  text: string;
}
export interface ComposerImage {
  id: string;
  /** Local (picker) uri for the thumbnail preview. */
  uri?: string;
  status?: 'uploading' | 'done' | 'error';
}

export function Composer({
  value,
  onChangeText,
  onSend,
  hero = false,
  streaming = false,
  onStop,
  onAttach,
  annotations = [],
  onClearAnnotation,
  images = [],
  onRemoveImage,
  barStyle,
  autoFocus = false,
}: {
  value: string;
  onChangeText: (v: string) => void;
  onSend: () => void;
  hero?: boolean;
  /** Focus the input on mount (widget/deep-link `compose=1` entry). */
  autoFocus?: boolean;
  streaming?: boolean;
  onStop?: () => void;
  onAttach?: () => void;
  recording?: boolean;
  onMic?: () => void;
  annotations?: Annotation[];
  onClearAnnotation?: (id: string) => void;
  images?: ComposerImage[];
  onRemoveImage?: (id: string) => void;
  /** Animated bottom inset for the bar (collapses to 0 as the keyboard opens). */
  barStyle?: AnimatedStyle<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const [h, setH] = useState(30);
  const [focused, setFocused] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const canSend = value.trim().length > 0 || images.length > 0;
  const showExpand = focused || value.length > 0;

  return (
    <Animated.View style={[styles.bar, barStyle]}>
      {/* annotations (引用追问) */}
      {annotations.length > 0 && (
        <View style={{ paddingHorizontal: 12, paddingTop: 10 }}>
          {annotations.map((a) => (
            <View key={a.id} style={styles.annotation}>
              <Icon name="quote" size={14} color={c.accentDeep} />
              <Text numberOfLines={2} style={styles.annotationText}>
                {a.text}
              </Text>
              <Touchable haptic="none" onPress={() => onClearAnnotation?.(a.id)} hitSlop={8}>
                <Icon name="x" size={14} color={c.fgMuted} />
              </Touchable>
            </View>
          ))}
        </View>
      )}

      {/* image previews */}
      {images.length > 0 && (
        <View style={styles.imageRow}>
          {images.map((im) => (
            <View key={im.id} style={styles.thumb}>
              {im.uri ? (
                <Image source={{ uri: im.uri }} style={styles.thumbImg} resizeMode="cover" />
              ) : (
                <Icon name="image" size={20} color={c.fgFaint} />
              )}
              <Touchable haptic="none" onPress={() => onRemoveImage?.(im.id)} style={styles.thumbX} hitSlop={6}>
                <Icon name="x" size={10} color="#fff" />
              </Touchable>
              {im.status === 'uploading' && (
                <View style={styles.thumbLoading}>
                  <Spinner size={16} />
                </View>
              )}
              {im.status === 'error' && (
                <View style={styles.thumbLoading}>
                  <Icon name="alert" size={16} color={c.danger} />
                </View>
              )}
            </View>
          ))}
        </View>
      )}

      {/* input row: + (attach) on the left, text field, fullscreen-expand on the right (on focus) */}
      <View style={styles.inputRow}>
        <ToolBtn icon="plus" onPress={onAttach} />
        <TextInput
          value={value}
          onChangeText={onChangeText}
          autoFocus={autoFocus}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={hero ? t('home.heroPlaceholder') : t('chat.followUpPlaceholder')}
          placeholderTextColor={c.fgFaint}
          multiline
          scrollEnabled
          onContentSizeChange={(e) => setH(Math.min(132, Math.max(30, e.nativeEvent.contentSize.height)))}
          style={[styles.input, { height: h + 12 }]}
        />
        {showExpand && (
          <Touchable haptic="none" onPress={() => setExpanded(true)} style={styles.expandBtn} hitSlop={6}>
            <Icon name="expand" size={18} color={c.fgMuted} sw={1.9} />
          </Touchable>
        )}
      </View>

      {/* toolbar: send (voice input hidden for now) */}
      <View style={styles.toolbar}>
        <View style={{ flex: 1 }} />
        {streaming ? <SendBtn stop onPress={onStop} /> : <SendBtn disabled={!canSend} onPress={onSend} />}
      </View>

      <FullScreenComposer
        visible={expanded}
        value={value}
        onChangeText={onChangeText}
        onClose={() => setExpanded(false)}
        onSend={() => {
          setExpanded(false);
          onSend();
        }}
        canSend={canSend}
        streaming={streaming}
        onStop={onStop}
        hero={hero}
      />
    </Animated.View>
  );
}

/** Immersive fullscreen editor — big textarea, send in the header (so it stays
 * reachable above the keyboard); body pads up with the keyboard. */
function FullScreenComposer({
  visible,
  value,
  onChangeText,
  onClose,
  onSend,
  canSend,
  streaming,
  onStop,
  hero,
}: {
  visible: boolean;
  value: string;
  onChangeText: (v: string) => void;
  onClose: () => void;
  onSend: () => void;
  canSend: boolean;
  streaming?: boolean;
  onStop?: () => void;
  hero?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const insets = useSafeAreaInsets();
  const pad = useBottomPadStyle(0);
  return (
    <Modal visible={visible} animationType="slide" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.fsRoot}>
        <View style={[styles.fsHeader, { paddingTop: insets.top + 8 }]}>
          <Touchable haptic="none" onPress={onClose} style={styles.fsHeaderBtn} hitSlop={6}>
            <Icon name="chevD" size={26} color={c.fg} />
          </Touchable>
          <Text style={styles.fsTitle}>{t('chat.editorTitle')}</Text>
          {streaming ? <SendBtn stop onPress={onStop} /> : <SendBtn disabled={!canSend} onPress={onSend} />}
        </View>
        <Animated.View style={[styles.fsBody, pad]}>
          <TextInput
            value={value}
            onChangeText={onChangeText}
            autoFocus
            multiline
            placeholder={hero ? t('home.heroPlaceholder') : t('chat.followUpPlaceholder')}
            placeholderTextColor={c.fgFaint}
            style={styles.fsInput}
            textAlignVertical="top"
          />
        </Animated.View>
      </View>
    </Modal>
  );
}

function ToolBtn({ icon, onPress, active }: { icon: 'plus' | 'mic'; onPress?: () => void; active?: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable
      onPress={onPress}
      style={[styles.toolBtn, active && { backgroundColor: c.dangerTint }]}
      pressedStyle={{ opacity: 0.6 }}
    >
      <Icon name={icon} size={21} color={active ? c.danger : c.fgMuted} sw={1.9} />
    </Touchable>
  );
}

function SendBtn({ disabled, stop, onPress }: { disabled?: boolean; stop?: boolean; onPress?: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable
      onPress={disabled ? undefined : onPress}
      disabled={disabled}
      pressedStyle={{ opacity: 0.85, transform: [{ scale: 0.94 }] }}
      style={[
        styles.send,
        stop
          ? { backgroundColor: c.surface, borderWidth: 1.5, borderColor: c.danger }
          : { backgroundColor: disabled ? c.surfaceMuted : c.accent },
        !disabled && !stop && shadow.accent,
      ]}
    >
      <Icon
        name={stop ? 'stop' : 'up'}
        size={stop ? 16 : 21}
        sw={2.4}
        color={stop ? c.danger : disabled ? c.fgFaint : c.onAccent}
      />
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  // Full-width flat bar (edge-to-edge), separated from the content by a top
  // hairline — no floating card / rounding / shadow.
  bar: {
    backgroundColor: c.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: c.hairline,
  },
  annotation: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    backgroundColor: c.accentTint,
    borderLeftWidth: 3,
    borderLeftColor: c.accentBorder,
    borderRadius: 8,
    paddingVertical: 7,
    paddingHorizontal: 10,
    marginBottom: 6,
  },
  annotationText: { flex: 1, fontSize: 12.5, color: c.fgSecondary, lineHeight: 18 },
  imageRow: { flexDirection: 'row', gap: 8, paddingHorizontal: 12, paddingTop: 10 },
  thumb: {
    width: 56,
    height: 56,
    borderRadius: 10,
    backgroundColor: c.surfaceMuted,
    borderWidth: 1,
    borderColor: c.hairline,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  thumbImg: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  thumbX: {
    position: 'absolute',
    top: 2,
    right: 2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(17,24,39,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  thumbLoading: {
    position: 'absolute',
    inset: 0,
    backgroundColor: 'rgba(255,255,255,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // taller default field; + and expand vertically centered with the text
  inputRow: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingLeft: 6, paddingRight: 8, paddingTop: 6, paddingBottom: 2 },
  input: { flex: 1, fontSize: 15.5, lineHeight: 21, color: c.fg, padding: 0, paddingHorizontal: 2, textAlignVertical: 'center' },
  expandBtn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, paddingBottom: 10, paddingTop: 2 },
  toolBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },

  // fullscreen editor
  fsRoot: { flex: 1, backgroundColor: c.bg },
  fsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 12,
    backgroundColor: c.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: c.hairline,
  },
  fsHeaderBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', marginLeft: -6 },
  fsTitle: { flex: 1, fontSize: 16, fontWeight: '700', color: c.fg },
  fsBody: { flex: 1 },
  fsInput: { flex: 1, fontSize: 17, lineHeight: 27, color: c.fg, paddingHorizontal: 20, paddingTop: 18, textAlignVertical: 'top' },
}));
