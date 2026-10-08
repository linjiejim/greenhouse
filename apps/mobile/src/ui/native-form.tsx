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
 *
 * Also here: `ColorSwatchPicker` — the palette row for data-driven colors (tag
 * / project colors) inside a Form section.
 */

import React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { Button, Form, HStack, Host, Image, Spacer, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits,
  accessibilityHidden,
  accessibilityLabel,
  environment,
  foregroundStyle,
  lineLimit,
  opacity,
  tint,
} from '@expo/ui/swift-ui/modifiers';
import type { SymbolViewProps } from 'expo-symbols';
import { usePrefs } from '../store/prefs';
import { useTheme } from '../theme';
import { selectionTick } from './haptics';

/**
 * SwiftUI `locale` environment for the app language — add to every `Host`'s
 * modifiers. SwiftUI wants ICU identifiers: the graphical DatePicker ignores a
 * BCP-47 tag like `zh-CN` (English month header) but honours `zh_Hans_CN`.
 */
export function useLocaleEnv() {
  const lang = usePrefs((s) => s.lang);
  return environment('locale', lang === 'zh' ? 'zh_Hans_CN' : 'en_US');
}

export function NativeForm({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { hex } = useTheme();
  const locale = useLocaleEnv();
  return (
    <Host style={[{ flex: 1 }, style]} modifiers={[font({ textStyle: 'body' }), tint(hex.accent), locale]}>
      <Form>{children}</Form>
    </Host>
  );
}

const SWATCH = 34;

/**
 * A color palette for a Form row (put it straight inside a `Section`): SF
 * Symbol swatches — a filled circle, the selected one ringed — evenly spread
 * in rows of `perRow`. Each swatch is a VoiceOver button with a spoken color
 * name (`nameOf`, falling back to the hex) and the selected trait. For
 * data-driven colors only (tag / project palettes), never UI colors.
 */
export function ColorSwatchPicker({
  colors,
  value,
  onChange,
  nameOf,
  perRow = 5,
  allowNone = false,
}: {
  colors: readonly string[];
  value: string | null;
  onChange: (color: string | null) => void;
  /** Spoken name of a swatch ("绿色"); falls back to the hex. */
  nameOf?: (color: string) => string | null | undefined;
  perRow?: number;
  /** Tapping the selected swatch clears the value (an optional color). */
  allowNone?: boolean;
}) {
  const same = (a: string | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
  const rows: string[][] = [];
  for (let i = 0; i < colors.length; i += perRow) rows.push(colors.slice(i, i + perRow));
  const pick = (col: string) => {
    if (same(value, col)) {
      if (!allowNone) return;
      selectionTick();
      onChange(null);
      return;
    }
    selectionTick();
    onChange(col);
  };
  return (
    <VStack spacing={14}>
      {rows.map((row, r) => (
        <HStack key={r}>
          {Array.from({ length: perRow }, (_, j) => {
            const col = row[j];
            const selected = col ? same(value, col) : false;
            return (
              <React.Fragment key={col ?? `pad-${j}`}>
                {j > 0 ? <Spacer /> : null}
                {col ? (
                  <Image
                    systemName={selected ? 'largecircle.fill.circle' : 'circle.fill'}
                    size={SWATCH}
                    color={col}
                    onPress={() => pick(col)}
                    modifiers={[
                      accessibilityLabel(nameOf?.(col) || col),
                      accessibilityAddTraits(selected ? ['isButton', 'isSelected'] : ['isButton']),
                    ]}
                  />
                ) : (
                  // keeps a short last row on the same grid as the rows above
                  <Image systemName="circle.fill" size={SWATCH} modifiers={[opacity(0), accessibilityHidden(true)]} />
                )}
              </React.Fragment>
            );
          })}
        </HStack>
      ))}
    </VStack>
  );
}

type SFSymbol = Extract<SymbolViewProps['name'], string>;

const PRIMARY = foregroundStyle({ type: 'hierarchical', style: 'primary' });
const SECONDARY = foregroundStyle({ type: 'hierarchical', style: 'secondary' });
const TERTIARY = foregroundStyle({ type: 'hierarchical', style: 'tertiary' });

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
  return (
    <Button onPress={onPress} modifiers={[PRIMARY]}>
      <HStack spacing={10}>
        {systemImage ? (
          <Image
            systemName={systemImage}
            modifiers={[systemImageColor ? foregroundStyle(systemImageColor) : SECONDARY, accessibilityHidden(true)]}
          />
        ) : null}
        <Text>{label}</Text>
        <Spacer />
        {value ? <Text modifiers={[SECONDARY, lineLimit(1)]}>{value}</Text> : null}
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
  onPress,
}: {
  label: string;
  detail?: string;
  systemImage?: SFSymbol;
  /** Data color for the leading symbol (tag / project color); default secondary. */
  systemImageColor?: string;
  checked: boolean;
  onPress: () => void;
}) {
  const { hex } = useTheme();
  return (
    <Button
      onPress={onPress}
      modifiers={[PRIMARY, accessibilityAddTraits(checked ? ['isButton', 'isSelected'] : ['isButton'])]}
    >
      <HStack spacing={10}>
        {systemImage ? (
          <Image
            systemName={systemImage}
            modifiers={[systemImageColor ? foregroundStyle(systemImageColor) : SECONDARY, accessibilityHidden(true)]}
          />
        ) : null}
        <VStack alignment="leading" spacing={2}>
          <Text>{label}</Text>
          {detail ? <Text modifiers={[font({ textStyle: 'footnote' }), SECONDARY, lineLimit(2)]}>{detail}</Text> : null}
        </VStack>
        <Spacer />
        {checked ? (
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
