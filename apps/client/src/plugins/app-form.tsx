/**
 * Fields of the native plugin page forms (./email/screen.tsx, ./memory/screen.tsx), the same
 * plugin plumbing as ./settings-screen.tsx: a caption, the system text input, then a hint or an
 * error under it. The browser pages use the shared web form controls instead.
 */
import React from 'react';
import { Text, TextInput, View, type KeyboardTypeOptions } from 'react-native';
import { makeStyles, radius, space, typo, useTheme, weight } from '../theme';

export function FormField({
  label,
  value,
  onChange,
  hint,
  error,
  counter,
  placeholder,
  secure,
  multiline,
  keyboard,
  autoComplete,
  editable = true,
  autoFocus,
}: {
  label: string;
  value: string;
  onChange?: (value: string) => void;
  hint?: string;
  error?: string | null;
  /** `12 / 80` beside the caption; red past the limit. */
  counter?: { length: number; max: number };
  placeholder?: string;
  secure?: boolean;
  multiline?: boolean;
  keyboard?: KeyboardTypeOptions;
  autoComplete?: 'email' | 'new-password' | 'off' | 'username';
  editable?: boolean;
  autoFocus?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.field}>
      <View style={styles.caption}>
        <Text style={styles.label}>{label}</Text>
        {counter ? (
          <Text style={[styles.counter, counter.length > counter.max && styles.over]}>
            {counter.length} / {counter.max}
          </Text>
        ) : null}
      </View>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        editable={editable}
        placeholder={placeholder}
        placeholderTextColor={c.tertiaryLabel}
        secureTextEntry={secure}
        multiline={multiline}
        keyboardType={keyboard}
        autoComplete={autoComplete}
        textContentType={secure ? 'password' : autoComplete === 'email' ? 'emailAddress' : 'none'}
        autoCapitalize="none"
        autoCorrect={!secure && !keyboard && autoComplete !== 'email'}
        autoFocus={autoFocus}
        style={[styles.input, multiline && styles.multiline, !editable && styles.readOnly]}
      />
      {error ? <Text style={styles.error}>{error}</Text> : hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  field: { gap: space.sm },
  caption: { flexDirection: 'row', alignItems: 'baseline', gap: space.sm },
  label: { ...typo.footnote, fontWeight: weight.semibold, color: c.label, flex: 1 },
  counter: { ...typo.caption1, color: c.secondaryLabel },
  over: { color: c.red, fontWeight: weight.bold },
  input: {
    ...typo.body,
    color: c.label,
    backgroundColor: c.secondaryGroupedBackground,
    borderWidth: 1,
    borderColor: c.separator,
    borderRadius: radius.sm,
    borderCurve: 'continuous',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    minHeight: 44,
  },
  multiline: { minHeight: 140, textAlignVertical: 'top' },
  readOnly: { color: c.secondaryLabel },
  hint: { ...typo.footnote, color: c.secondaryLabel },
  error: { ...typo.footnote, color: c.red },
}));
