/**
 * What sits above the composer's input row (its `accessory`), one at a time:
 *
 *  - editing my last message: "Editing · Cancel";
 *  - the `@` / `/` list while typing (./use-composer.ts `picker`): a glass capsule of people
 *    and Agents (face + name) or of skills (`/name` + its display name; one that cannot run here
 *    is dimmed and says why when tapped). Taps never dismiss the keyboard;
 *  - a chosen skill's fields (CONV-11): a text field or a choice per field, required ones marked;
 *    the first takes the focus.
 */

import React, { memo, useEffect, useRef } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useT } from '../lib/i18n';
import type { Skill } from '../shared/contract';
import { HIT, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { AgentAvatar, MemberAvatar, type AgentFace } from '../ui/agent-avatar';
import { NativeButton } from '../ui/button';
import { Icon } from '../ui/core';
import { alertError } from '../ui/dialogs';
import { Glass } from '../ui/glass';
import { NativeMenu } from '../ui/menu';
import type { PickerEntry } from './use-composer';

/** How a candidate looks: an Agent's plant or a person's face. */
export type CandidateFace = { agent: AgentFace } | { person: { name: string; avatarUrl: string | null } };

export const PickerStrip = memo(function PickerStrip({
  entries,
  faces,
  onPick,
}: {
  entries: PickerEntry[];
  faces: (handle: string) => CandidateFace | undefined;
  onPick: (entry: PickerEntry) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
      <Glass style={styles.capsule}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          keyboardShouldPersistTaps="always"
          contentContainerStyle={styles.items}
        >
          {entries.map((entry) => {
            if (entry.kind === 'skill') {
              const { skill } = entry;
              return (
                <Pressable
                  key={entry.key}
                  onPress={() =>
                    skill.available
                      ? onPick(entry)
                      : alertError(t('composer.skillUnavailable', { name: skill.name }), skill.unavailable?.message)
                  }
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !skill.available }}
                  accessibilityLabel={`/${skill.name}${skill.display_name ? `, ${skill.display_name}` : ''}`}
                  style={({ pressed }) => [styles.item, !skill.available && styles.dim, pressed && styles.pressed]}
                >
                  <Icon name="wand" size={14} color={skill.available ? c.accent : c.tertiaryLabel} />
                  <Text numberOfLines={1} style={styles.name}>
                    /{skill.name}
                  </Text>
                  {skill.display_name ? (
                    <Text numberOfLines={1} style={styles.hint}>
                      {skill.display_name}
                    </Text>
                  ) : null}
                </Pressable>
              );
            }
            const face = faces(entry.candidate.handle);
            return (
              <Pressable
                key={entry.key}
                onPress={() => onPick(entry)}
                accessibilityRole="button"
                accessibilityLabel={t('composer.mentionA11y', { name: entry.candidate.name })}
                style={({ pressed }) => [styles.item, pressed && styles.pressed]}
              >
                {face && 'agent' in face ? (
                  <AgentAvatar agent={face.agent} size={22} />
                ) : (
                  <MemberAvatar
                    name={face && 'person' in face ? face.person.name : entry.candidate.name}
                    url={face && 'person' in face ? face.person.avatarUrl : null}
                    size={22}
                  />
                )}
                <Text numberOfLines={1} style={styles.name}>
                  {entry.candidate.name}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      </Glass>
    </Animated.View>
  );
});

export const SkillFields = memo(function SkillFields({
  skill,
  values,
  onChange,
  onSubmit,
}: {
  skill: Skill;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  onSubmit: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  const first = useRef<TextInput>(null);
  useEffect(() => {
    const timer = setTimeout(() => first.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [skill.id]);
  if (!skill.variables.length) return null;
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
      <Glass style={styles.fields}>
        {skill.variables.map((field, index) => {
          const label = `${field.label}${field.required !== false ? ' *' : ''}`;
          if (field.type === 'choice' && field.options?.length) {
            return (
              <View key={field.key} style={styles.field}>
                <Text style={styles.fieldLabel}>{label}</Text>
                <NativeMenu
                  items={field.options.map((option) => ({
                    id: option,
                    title: option,
                    checked: values[field.key] === option,
                  }))}
                  onSelect={(option) => onChange(field.key, option)}
                  fill={false}
                >
                  <View style={styles.choice} accessible accessibilityRole="button" accessibilityLabel={label}>
                    <Text numberOfLines={1} style={values[field.key] ? styles.choiceText : styles.choicePlaceholder}>
                      {values[field.key] || t('composer.choose')}
                    </Text>
                    <Icon name="chevUpDown" size={12} color={c.secondaryLabel} />
                  </View>
                </NativeMenu>
              </View>
            );
          }
          return (
            <View key={field.key} style={styles.field}>
              <Text style={styles.fieldLabel}>{label}</Text>
              <TextInput
                ref={index === 0 ? first : undefined}
                value={values[field.key] ?? ''}
                onChangeText={(text) => onChange(field.key, text)}
                placeholder={field.label}
                placeholderTextColor={c.placeholder}
                returnKeyType={index === skill.variables.length - 1 ? 'send' : 'next'}
                onSubmitEditing={index === skill.variables.length - 1 ? onSubmit : undefined}
                style={styles.input}
                accessibilityLabel={label}
              />
            </View>
          );
        })}
      </Glass>
    </Animated.View>
  );
});

export function EditingBar({ onCancel }: { onCancel: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const t = useT();
  return (
    <Animated.View entering={FadeIn.duration(160)} exiting={FadeOut.duration(120)}>
      <Glass style={styles.editing}>
        <Icon name="pen" size={14} color={c.secondaryLabel} />
        <Text style={styles.editingText}>{t('composer.editing')}</Text>
        <NativeButton label={t('common.cancel')} size="small" onPress={onCancel} />
      </Glass>
    </Animated.View>
  );
}

const useStyles = makeStyles((c) => ({
  capsule: { minHeight: HIT, borderRadius: HIT / 2, overflow: 'hidden', justifyContent: 'center' },
  items: { alignItems: 'center', paddingHorizontal: space.xs },
  item: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 2, minHeight: HIT, paddingHorizontal: space.sm + 2 },
  dim: { opacity: 0.45 },
  pressed: { opacity: 0.55 },
  name: { ...typo.subheadline, fontWeight: weight.medium, color: c.label, maxWidth: 160 },
  hint: { ...typo.footnote, color: c.secondaryLabel, maxWidth: 140 },
  fields: { borderRadius: radius.xl, padding: space.md, gap: space.sm, ...squircle },
  field: { gap: space.xs },
  fieldLabel: { ...typo.footnote, fontWeight: weight.medium, color: c.secondaryLabel },
  input: {
    ...typo.body,
    color: c.label,
    minHeight: HIT,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    ...squircle,
  },
  choiceText: { flex: 1, ...typo.body, color: c.label },
  choicePlaceholder: { flex: 1, ...typo.body, color: c.placeholder },
  editing: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: HIT,
    borderRadius: HIT / 2,
    paddingLeft: space.lg,
    paddingRight: space.sm,
  },
  editingText: { flex: 1, ...typo.subheadline, color: c.secondaryLabel },
}));
