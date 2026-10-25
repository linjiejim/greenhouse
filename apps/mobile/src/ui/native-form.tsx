import { brandFont as font } from './brand-font';
/**
 * Real SwiftUI forms — the standard for every settings / edit / create screen.
 *
 * `NativeForm` is a full-screen `Host` + SwiftUI `Form` (inset-grouped list)
 * tinted with the accent. Put `@expo/ui/swift-ui` controls straight inside:
 * `Section` (title / footer), `TextField` / `SecureField`, `Toggle`, `Picker`
 * (menu / inline / segmented / navigationLink styles), `DatePicker` (compact),
 * `LabeledContent`, `Button` (role="destructive" for delete/sign-out),
 * `Stepper`, `DisclosureGroup`. Keyboard avoidance, focus, AutoFill, Dynamic
 * Type and VoiceOver are all native.
 *
 * Usage (inside a screen that declares its own Stack.Screen / Stack.Toolbar):
 *   <NativeForm>
 *     <Section title={t('x.section')}>
 *       <TextField placeholder="…" onTextChange={setName} />
 *       <Toggle label="…" isOn={on} onIsOnChange={setOn} />
 *     </Section>
 *   </NativeForm>
 *
 * Inside SwiftUI only SwiftUI views render — to embed an RN view (the brand
 * mark, a tag chip preview), wrap it in `RNHostView matchContents`. Keep those
 * islands small; never put RN lists inside a Form.
 *
 * Locale: SwiftUI controls format with the *device* locale by default; every
 * Host the app owns gets `useLocaleEnv()` so date pickers etc. follow the
 * in-app language (zh UI → "2026年6月1日", not "Jun 1, 2026"). Hosts you create
 * yourself (a bare `Host` around a `DatePicker`) must add it too.

 */

import React from 'react';
import { useWindowDimensions, type StyleProp, type ViewStyle } from 'react-native';
import { Button, Form, HStack, Host, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityHidden,
  background,
  environment,
  frame,
  foregroundStyle,
  lineLimit,
  listRowBackground,
  redacted,
  scrollContentBackground,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import type { SymbolViewProps } from 'expo-symbols';
import { useT } from '../lib/i18n';
import { usePrefs } from '../store/prefs';
import { space, useTheme } from '../theme';

/**
 * SwiftUI `locale` environment for the app language — add to every `Host`'s
 * modifiers. SwiftUI wants ICU identifiers: the graphical DatePicker ignores a
 * BCP-47 tag like `zh-CN` (English month header) but honours `zh_Hans_CN`.
 */
export function useLocaleEnv() {
  const lang = usePrefs((s) => s.lang);
  return environment('locale', lang === 'zh' ? 'zh_Hans_CN' : 'en_US');
}

export function NativeForm({
  children,
  style,
  background: canvas,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  /** A page colour instead of the system grouped grey (sign-in sits on `brandCanvas`). */
  background?: string;
}) {
  const { hex, isDark } = useTheme();
  const locale = useLocaleEnv();
  return (
    <Host
      colorScheme={isDark ? 'dark' : 'light'}
      style={[{ flex: 1 }, style]}
      modifiers={[font({ textStyle: 'body' }), tint(hex.accent), locale]}
    >
      <Form modifiers={canvas ? [scrollContentBackground('hidden'), background(canvas)] : undefined}>{children}</Form>
    </Host>
  );
}

type SFSymbol = Extract<SymbolViewProps['name'], string>;

const PRIMARY = foregroundStyle({ type: 'hierarchical', style: 'primary' });
const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const TERTIARY = foregroundStyle({ type: 'hierarchical', style: 'tertiary' });

/** Static form-shaped placeholders; the Form itself stays mounted while a read finishes. */
export function FormLoading() {
  const t = useT();
  return (
    <VStack alignment="leading" spacing={space.lg}>
      <Text modifiers={[SECONDARY]}>{t('common.loading')}</Text>
      {[3, 2].map((length) => (
        <Text key={length} modifiers={[redacted('placeholder'), accessibilityHidden(true)]}>
          {t('common.loading').repeat(length)}
        </Text>
      ))}
    </VStack>
  );
}

/**
 * A Form row that navigates somewhere (Settings-style): optional leading SF
 * Symbol, label, muted trailing value and a disclosure chevron — label-colored,
 * not tinted like a plain Button.
 */
export function FormNavRow({
  label,
  value,
  systemImage,
  systemImageColor,
  onPress,
}: {
  label: string;
  value?: string;
  systemImage?: SFSymbol;
  /** Data color for the leading symbol (tag / project color); default secondary. */
  systemImageColor?: string;
  onPress: () => void;
}) {
  const { fontScale } = useWindowDimensions();
  const large = fontScale >= 1.5;
  return (
    <Button onPress={onPress} modifiers={[PRIMARY]}>
      <HStack spacing={10}>
        {systemImage ? (
          <Image
            systemName={systemImage}
            modifiers={[systemImageColor ? foregroundStyle(systemImageColor) : SECONDARY, accessibilityHidden(true)]}
          />
        ) : null}
        {large ? (
          <VStack alignment="leading" spacing={space.xs}>
            <Text>{label}</Text>
            {value ? <Text modifiers={[SECONDARY]}>{value}</Text> : null}
          </VStack>
        ) : (
          <Text>{label}</Text>
        )}
        <Spacer />
        {!large && value ? <Text modifiers={[SECONDARY, lineLimit(1)]}>{value}</Text> : null}
        <Image
          systemName="chevron.right"
          modifiers={[font({ size: 13, weight: 'semibold' }), TERTIARY, accessibilityHidden(true)]}
        />
      </HStack>
    </Button>
  );
}

/**
 * A Form row in a single-choice list: label (+ optional leading symbol and
 * secondary line) with the accent checkmark on the selected row.
 */
export function FormCheckRow({
  label,
  detail,
  systemImage,
  systemImageColor,
  checked,
  choice,
  onPress,
}: {
  label: string;
  detail?: string;
  systemImage?: SFSymbol;
  /** Data color for the leading symbol (tag / project color); default secondary. */
  systemImageColor?: string;
  checked: boolean;
  /** Explicit selection control for question forms; default retains Settings-style checks. */
  choice?: 'single' | 'multiple';
  onPress: () => void;
}) {
  const { hex } = useTheme();
  return (
    <Button
      onPress={onPress}
      modifiers={[
        PRIMARY,
        accessibilityAddTraits(checked ? ['isButton', 'isSelected'] : ['isButton']),
        ...(choice && checked ? [listRowBackground(hex.accentFill)] : []),
      ]}
    >
      <HStack spacing={12}>
        {choice ? (
          <Image
            systemName={
              choice === 'multiple'
                ? checked
                  ? 'checkmark.square.fill'
                  : 'square'
                : checked
                  ? 'largecircle.fill.circle'
                  : 'circle'
            }
            modifiers={[
              frame({ width: 24 }),
              font({ textStyle: 'title3' }),
              checked ? foregroundStyle(hex.accent) : SECONDARY,
              accessibilityHidden(true),
            ]}
          />
        ) : null}
        {systemImage ? (
          <Image
            systemName={systemImage}
            modifiers={[systemImageColor ? foregroundStyle(systemImageColor) : SECONDARY, accessibilityHidden(true)]}
          />
        ) : null}
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={choice ? [font({ textStyle: 'callout', weight: checked ? 'semibold' : 'regular' })] : []}>
            {label}
          </Text>
          {detail ? <Text modifiers={[font({ textStyle: 'footnote' }), SECONDARY]}>{detail}</Text> : null}
        </VStack>
        <Spacer />
        {checked && !choice ? (
          // foregroundStyle, not tint: inside a primary-styled Button tint doesn't recolor an Image
          <Image
            systemName="checkmark"
            modifiers={[font({ weight: 'semibold' }), foregroundStyle(hex.accent), accessibilityHidden(true)]}
          />
        ) : null}
      </HStack>
    </Button>
  );
}
