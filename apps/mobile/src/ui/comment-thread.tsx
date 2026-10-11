/**
 * A comment thread's pieces, shared by the project task page and the Tables /
 * app record pages (one thread look, one composer):
 *
 *  - `CommentRow` — avatar · name · relative time over the body (plain text, or
 *    Markdown for Tables comments, where `[@Name](user:id)` mentions read as bold
 *    names); long-press opens its menu (copy / delete);
 *  - `CommentComposer` — the Liquid Glass composer pinned above the keyboard
 *    (`useReanimatedKeyboardAnimation`), with an optional `@` person strip
 *    (`MentionStrip`) floating above it while the caret sits in an `@` token —
 *    picking someone writes "@Name " (src/lib/mentions.ts; links on send).
 */

import React from 'react';
import {
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  Pressable,
  type NativeSyntheticEvent,
  type TextInputSelectionChangeEventData,
} from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Markdown } from '../chat/markdown';
import { relativeTime } from '../lib/format';
import { mentionsForDisplay, type MentionMember } from '../lib/mentions';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { InitialAvatar } from './avatar';
import { Glass, GlassGroup, GlassIconButton } from './glass';
import { NativeMenu, type MenuItem } from './menu';

export function CommentRow({
  author,
  createdAt,
  body,
  markdown = false,
  edited,
  last,
  items,
  onSelect,
}: {
  author: string;
  createdAt: string;
  body: string;
  /** Render the body as Markdown (Tables comments). */
  markdown?: boolean;
  /** Suffix after the time ("edited"). */
  edited?: string;
  last: boolean;
  items: MenuItem[];
  onSelect: (id: string) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <NativeMenu trigger="longPress" items={items} onSelect={onSelect}>
      <View style={styles.comment}>
        <InitialAvatar name={author} size={30} tint={c.gray} />
        <View style={styles.commentBody}>
          <View style={styles.commentHead}>
            <Text numberOfLines={1} style={styles.commentAuthor}>
              {author}
            </Text>
            <Text style={styles.commentTime}>
              {relativeTime(createdAt)}
              {edited ? ` · ${edited}` : ''}
            </Text>
          </View>
          {markdown ? <Markdown source={mentionsForDisplay(body)} /> : <Text style={styles.commentText}>{body}</Text>}
        </View>
        {!last ? <View pointerEvents="none" style={styles.commentSep} /> : null}
      </View>
    </NativeMenu>
  );
}

/** Height the composer takes over the content (pad the scroll view's bottom by it). */
export const COMPOSER_SPACE = 76;

export function CommentComposer({
  value,
  onChange,
  onSend,
  sending,
  placeholder,
  sendLabel,
  onSelectionChange,
  mentions,
  onPickMention,
}: {
  value: string;
  onChange: (text: string) => void;
  onSend: () => void;
  sending: boolean;
  placeholder: string;
  /** VoiceOver label of the send button. */
  sendLabel: string;
  onSelectionChange?: (selection: { start: number; end: number }) => void;
  /** People matching the `@` token at the caret (empty: no strip). */
  mentions?: readonly MentionMember[];
  onPickMention?: (person: MentionMember) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const insets = useSafeAreaInsets();
  const { height: kbHeight, progress: kbProgress } = useReanimatedKeyboardAnimation();
  const composerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: kbHeight.value + insets.bottom * kbProgress.value }],
  }));
  return (
    <Animated.View style={[styles.composerWrap, { paddingBottom: insets.bottom + space.sm }, composerStyle]}>
      {mentions?.length && onPickMention ? <MentionStrip people={mentions} onPick={onPickMention} /> : null}
      <GlassGroup spacing={10} style={styles.composerRow}>
        <Glass style={styles.inputGlass}>
          <TextInput
            value={value}
            onChangeText={onChange}
            onSelectionChange={
              onSelectionChange
                ? (e: NativeSyntheticEvent<TextInputSelectionChangeEventData>) =>
                    onSelectionChange(e.nativeEvent.selection)
                : undefined
            }
            placeholder={placeholder}
            placeholderTextColor={c.placeholder}
            multiline
            style={styles.input}
          />
        </Glass>
        <GlassIconButton
          icon="up"
          prominent
          size={40}
          disabled={!value.trim() || sending}
          onPress={onSend}
          accessibilityLabel={sendLabel}
        />
      </GlassGroup>
    </Animated.View>
  );
}

/** People to mention, as a row of avatar chips above the composer (a tap writes "@Name "). */
export function MentionStrip({
  people,
  onPick,
}: {
  people: readonly MentionMember[];
  onPick: (person: MentionMember) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Glass style={styles.strip}>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="always"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.stripRow}
      >
        {people.slice(0, 20).map((person) => (
          <Pressable
            key={person.id}
            onPress={() => onPick(person)}
            accessibilityRole="button"
            accessibilityLabel={person.name}
            style={({ pressed }) => [styles.chip, pressed && { opacity: 0.6 }]}
          >
            <InitialAvatar name={person.name} size={24} tint={c.gray} />
            <Text numberOfLines={1} style={styles.chipText}>
              {person.name}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </Glass>
  );
}

const useStyles = makeStyles((c) => ({
  comment: { flexDirection: 'row', gap: space.md, paddingVertical: space.md, minHeight: HIT },
  commentBody: { flex: 1, minWidth: 0, gap: 2 },
  commentHead: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  commentAuthor: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label, flexShrink: 1 },
  commentTime: { ...typo.footnote, color: c.tertiaryLabel },
  commentText: { ...typo.body, color: c.label },
  commentSep: {
    position: 'absolute',
    right: -space.margin,
    bottom: 0,
    left: 30 + space.md,
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.separator,
  },

  composerWrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: space.md, gap: space.sm },
  composerRow: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm },
  inputGlass: { flex: 1, borderRadius: 22, minHeight: 44, justifyContent: 'center' },
  input: {
    ...typo.body,
    color: c.label,
    paddingHorizontal: space.lg,
    paddingTop: 11,
    paddingBottom: 11,
    maxHeight: 120,
  },
  strip: { borderRadius: radius.xl, ...squircle, overflow: 'hidden' },
  stripRow: { paddingHorizontal: space.sm, paddingVertical: space.sm, gap: space.sm },
  chip: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, paddingRight: space.sm, maxWidth: 180 },
  chipText: { ...typo.subheadline, color: c.label, flexShrink: 1 },
}));
