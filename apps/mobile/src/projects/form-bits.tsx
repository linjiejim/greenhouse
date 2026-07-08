/**
 * Small form atoms shared by the project/task sheets: a section label, a
 * single-select chip row (status / priority / visibility) and a picker row
 * that opens a sheet (assignee / owner).
 */

import React from 'react';
import { ScrollView, Text, View } from 'react-native';
import { font, makeStyles, radius, useTheme, weight } from '../theme';
import { Icon, Touchable } from '../ui';

export function FormLabel({ text }: { text: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return <Text style={styles.label}>{text}</Text>;
}

export interface ChipOption<T extends string> {
  id: T;
  label: string;
  /** Optional accent for the active state (defaults to the theme accent). */
  color?: string;
}

/** Single-select chip row; scrolls horizontally when options overflow. */
export function OptionChips<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<ChipOption<T>>;
  value: T;
  onChange: (v: T) => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chipRow}>
      {options.map((opt) => {
        const active = opt.id === value;
        const tone = opt.color ?? c.accent;
        return (
          <Touchable
            key={opt.id}
            haptic="selection"
            onPress={() => onChange(opt.id)}
            style={[
              styles.chip,
              active
                ? { borderColor: tone, backgroundColor: c.surface }
                : { borderColor: c.hairline, backgroundColor: c.surface },
            ]}
          >
            {active ? <View style={[styles.chipDot, { backgroundColor: tone }]} /> : null}
            <Text style={[styles.chipText, active && { color: c.fg, fontWeight: weight.semibold }]}>{opt.label}</Text>
          </Touchable>
        );
      })}
    </ScrollView>
  );
}

/** A form row displaying the current pick; tapping opens a picker sheet. */
export function PickerRow({ value, placeholder, onPress }: { value?: string | null; placeholder: string; onPress: () => void }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable haptic="none" onPress={onPress} pressedStyle={{ opacity: 0.7 }} style={styles.pickerRow}>
      <Text style={[styles.pickerText, !value && { color: c.fgFaint }]}>{value || placeholder}</Text>
      <Icon name="chevR" size={15} color={c.fgFaint} />
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  label: { fontSize: font.caption, color: c.fgMuted, marginBottom: 6, fontWeight: weight.medium },
  chipRow: { flexDirection: 'row', gap: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: radius.full,
    borderWidth: 1.5,
  },
  chipDot: { width: 7, height: 7, borderRadius: 4 },
  chipText: { fontSize: font.small, color: c.fgSecondary, fontWeight: weight.medium },
  pickerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    paddingHorizontal: 12,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
  },
  pickerText: { flex: 1, fontSize: font.label, color: c.fg },
}));
