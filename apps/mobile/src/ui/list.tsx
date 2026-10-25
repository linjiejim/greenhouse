/**
 * List building blocks for React Native–rendered lists. They reproduce UIKit's inset-grouped
 * geometry: 44-pt minimum rows, 16-pt margins, separators inset to the text, continuous-corner
 * cards, `fill` press highlight, secondary text in `secondaryLabel`, chevrons in `tertiaryLabel`.
 * Pure settings screens use SwiftUI instead (src/ui/native-form.tsx).
 *
 *  - `Section` — a card of rows with an optional header and footer (`inset` or `plain`).
 *  - `Row` — icon tile or custom leading view, title + subtitle, trailing value or accessory,
 *    an optional `footer` under the row. Long-press menus wrap the row in
 *    `NativeMenu trigger="longPress"` (mirror its actions in `accessibilityActions`).
 *  - Virtualized lists give each row its `position` (`rowPosition(index, count)`) and it draws
 *    its own slice of the card; titles come from `SectionHeader` / `SectionFooter`, free-form
 *    content from `Card`.
 *  - `IconTile` — the rounded square behind a row icon; `Badge` — a small status capsule.
 */

import React, { Children, isValidElement } from 'react';
import {
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type ColorValue,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from 'react-native';
import { HIT, alpha, makeStyles, radius, space, squircle, typo, useTheme, weight } from '../theme';
import { Icon, type IconName } from './core';
import { useFontScaleKey } from './font-scale';

/** Default leading tile size (Settings-style icon tile). */
export const LIST_TILE = 30;
const TILE = LIST_TILE;

/** Separator / footer inset from the row's leading edge: aligns with the text. */
export function separatorInset(leadingWidth?: number): number {
  return leadingWidth ? space.margin + leadingWidth + space.md : space.margin;
}

export { rowPosition, type RowPosition } from '../data/row-position';
import type { RowPosition } from '../data/row-position';

export function SectionHeader({
  title,
  variant = 'inset',
  style,
}: {
  title: string;
  variant?: 'inset' | 'plain';
  style?: StyleProp<TextStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Text
      accessibilityRole="header"
      style={[styles.header, variant === 'plain' ? styles.headerPlain : styles.outerInset, style]}
    >
      {title}
    </Text>
  );
}

export function SectionFooter({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return <Text style={[styles.footer, styles.outerInset, style]}>{text}</Text>;
}

/** The inset-grouped card surface for custom content (16-pt outer margin, group radius). */
export function Card({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return <View style={[styles.insetCard, styles.outerInset, style]}>{children}</View>;
}

export function Section({
  header,
  footer,
  children,
  variant = 'inset',
  style,
}: {
  header?: string;
  footer?: string;
  children: React.ReactNode;
  variant?: 'inset' | 'plain';
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const rows = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[variant === 'inset' ? styles.insetWrap : null, style]}>
      {header ? (
        <Text accessibilityRole="header" style={[styles.header, variant === 'plain' && styles.headerPlain]}>
          {header}
        </Text>
      ) : null}
      <View style={variant === 'inset' ? styles.insetCard : styles.plainCard}>
        {rows.map((row, i) =>
          React.cloneElement(row as React.ReactElement<RowProps>, {
            key: row.key ?? i,
            last: i === rows.length - 1,
          }),
        )}
      </View>
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

export interface RowProps {
  title: string;
  subtitle?: string;
  /** Subtitle lines (default 2). */
  subtitleLines?: number;
  /** Leading SF-symbol icon on a tinted tile. */
  icon?: IconName;
  /** Tile color (defaults to the accent). Use system colors for meaning. */
  iconTint?: ColorValue;
  /** Plain leading view instead of a tile (avatars, color dots). */
  leading?: React.ReactNode;
  /** Width of `leading`, so the separator insets to the text (default: the tile width). */
  leadingWidth?: number;
  /** Muted trailing text (e.g. the current value). */
  value?: string;
  /** Trailing accessory. `chevron` for navigation, `check` for the selected choice. */
  accessory?: 'chevron' | 'check' | 'none' | React.ReactNode;
  /** Content under the row, aligned with the text (expanded details). Not part of the tap target. */
  footer?: React.ReactNode;
  onPress?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Title lines (default 1). */
  titleLines?: number;
  /** Where a title too long for its lines is cut: file names keep their extension (`middle`). */
  titleEllipsize?: 'tail' | 'middle';
  /**
   * The row is the trigger of a wrapping `NativeMenu trigger="tap"` (no
   * `onPress` of its own): it reads as a button, the menu being its action.
   */
  menuTrigger?: boolean;
  accessibilityLabel?: string;
  /** VoiceOver actions — e.g. the items of a wrapping long-press menu. */
  accessibilityActions?: readonly AccessibilityActionInfo[];
  onAccessibilityAction?: (event: AccessibilityActionEvent) => void;
  /** Virtualized inset-grouped lists: this row's place in its card (draws its own corners). */
  position?: RowPosition;
  /** Set by Section — hides the separator under the last row. */
  last?: boolean;
  /** A quiet row (home's recent conversations): the title in the secondary label color. */
  quiet?: boolean;
}

export function Row({
  title,
  subtitle,
  subtitleLines = 2,
  icon,
  iconTint,
  leading,
  leadingWidth,
  value,
  accessory = 'none',
  footer,
  onPress,
  destructive,
  disabled,
  titleLines = 1,
  titleEllipsize = 'tail',
  menuTrigger,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
  position,
  last,
  quiet,
}: RowProps) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const inset = separatorInset(icon ? TILE : leading ? (leadingWidth ?? TILE) : undefined);
  const fontKey = useFontScaleKey();
  const large = Number(fontKey) >= 1.5;
  const isLast = last || position === 'last' || position === 'only';
  return (
    <View
      style={
        position
          ? [
              styles.segment,
              (position === 'first' || position === 'only') && styles.segmentTop,
              (position === 'last' || position === 'only') && styles.segmentBottom,
            ]
          : undefined
      }
    >
      <RowTarget
        onPress={onPress}
        disabled={disabled}
        menuTrigger={menuTrigger}
        accessibilityLabel={accessibilityLabel}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        pressedColor={c.fill}
        style={[styles.row, disabled && { opacity: 0.4 }]}
      >
        {icon ? <IconTile icon={icon} tint={iconTint} /> : leading}
        <View style={[styles.body, large && { flexWrap: 'wrap' }]}>
          {/* keyed on the text size: re-measures when Dynamic Type changes (./font-scale.ts) */}
          <View key={fontKey} style={[styles.texts, large && { flexBasis: '100%' }]}>
            <Text
              numberOfLines={large ? 0 : titleLines}
              ellipsizeMode={titleEllipsize}
              style={[styles.title, quiet && { color: c.secondaryLabel }, destructive && { color: c.red }]}
            >
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={large ? 0 : subtitleLines} style={styles.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {value ? (
            <Text numberOfLines={large ? 0 : 1} style={[styles.value, large && { maxWidth: '100%' }]}>
              {value}
            </Text>
          ) : null}
          {accessory === 'chevron' ? (
            <Icon name="chevR" size={14} weight="semibold" color={c.tertiaryLabel} />
          ) : accessory === 'check' ? (
            <Icon name="check" size={17} weight="semibold" color={c.accent} />
          ) : accessory === 'none' ? null : (
            accessory
          )}
        </View>
      </RowTarget>
      {footer ? <View style={[styles.footerSlot, { paddingLeft: inset }]}>{footer}</View> : null}
      {/* separator runs from the text edge to the trailing edge, like UIKit */}
      {!isLast ? <View pointerEvents="none" style={[styles.sepLine, { left: inset }]} /> : null}
    </View>
  );
}

/**
 * A row's tap target: a Pressable button when it has `onPress`, else one
 * accessible View. Not a Pressable disabled for want of `onPress` — VoiceOver
 * would read a menu trigger or a plain information row as "dimmed", the same
 * as a row that really is off (only `disabled` says that).
 */
function RowTarget({
  onPress,
  disabled,
  menuTrigger,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
  pressedColor,
  style,
  children,
}: Pick<
  RowProps,
  'onPress' | 'disabled' | 'menuTrigger' | 'accessibilityLabel' | 'accessibilityActions' | 'onAccessibilityAction'
> & { pressedColor: ColorValue; style: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const a11y = {
    accessibilityLabel,
    accessibilityActions,
    onAccessibilityAction,
    accessibilityState: disabled ? { disabled: true } : undefined,
  };
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        {...a11y}
        style={({ pressed }) => [style, pressed ? { backgroundColor: pressedColor } : null]}
      >
        {children}
      </Pressable>
    );
  }
  return (
    <View accessible accessibilityRole={menuTrigger && !disabled ? 'button' : undefined} {...a11y} style={style}>
      {children}
    </View>
  );
}

/**
 * The rounded colored square behind a Settings-style row icon. Defaults to the
 * accent (glyph in `onAccent`); system-color / data tints get a white glyph
 * (`onTint`), like iOS Settings.
 */
export function IconTile({ icon, tint, size = TILE }: { icon: IconName; tint?: ColorValue; size?: number }) {
  const { colors: c, hex } = useTheme();
  const onAccent = !tint || tint === c.accent || tint === hex.accent;
  return (
    <View
      style={[
        squircle,
        {
          width: size,
          height: size,
          borderRadius: size * 0.27,
          backgroundColor: tint ?? c.accent,
          alignItems: 'center',
          justifyContent: 'center',
        },
      ]}
    >
      <Icon name={icon} size={Math.round(size * 0.58)} weight="medium" color={onAccent ? c.onAccent : c.onTint} />
    </View>
  );
}

export type BadgeTone = 'neutral' | 'accent' | 'red' | 'orange' | 'green' | 'blue';

/**
 * A small capsule label: 当前 on a version, a doc category, a task status.
 * `tone` picks a system color pair (tinted text on its faint fill); `color`
 * (a data-driven hex — tag / project color) draws a dot + label on a faint
 * wash of that color instead.
 */
export function Badge({
  label,
  icon,
  tone = 'neutral',
  color,
  style,
}: {
  label: string;
  icon?: IconName;
  tone?: BadgeTone;
  color?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const tones: Record<BadgeTone, [ColorValue, ColorValue]> = {
    neutral: [c.secondaryLabel, c.tertiaryFill],
    accent: [c.accentText, c.accentFill],
    red: [c.red, c.redFill],
    orange: [c.orange, c.orangeFill],
    green: [c.green, c.greenFill],
    blue: [c.blue, c.blueFill],
  };
  const [fg, bg] = color ? [c.label, alpha(color, 0.16)] : tones[tone];
  return (
    <View style={[styles.badge, { backgroundColor: bg }, style]}>
      {color ? (
        <View style={[styles.badgeDot, { backgroundColor: color }]} />
      ) : icon ? (
        <Icon name={icon} size={11} weight="semibold" color={fg} />
      ) : null}
      <Text numberOfLines={1} style={[styles.badgeText, { color: fg }]}>
        {label}
      </Text>
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  insetWrap: { marginHorizontal: space.margin, marginBottom: space.xxl },
  outerInset: { marginHorizontal: space.margin },
  header:
    Platform.OS === 'android'
      ? // Material list headers: sentence case in the primary color (as in Android Settings)
        {
          ...typo.subheadline,
          fontWeight: weight.medium,
          color: c.accent,
          paddingHorizontal: space.margin,
          paddingBottom: space.sm,
        }
      : {
          ...typo.footnote,
          color: c.secondaryLabel,
          textTransform: 'uppercase',
          paddingHorizontal: space.margin,
          paddingBottom: space.sm - 2,
        },
  headerPlain: { ...typo.headline, textTransform: 'none', color: c.label },
  insetCard: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    overflow: 'hidden',
    ...squircle,
  },
  plainCard: { backgroundColor: c.background },
  footer: { ...typo.footnote, color: c.secondaryLabel, paddingHorizontal: space.margin, paddingTop: space.sm - 2 },
  segment: {
    marginHorizontal: space.margin,
    backgroundColor: c.secondaryGroupedBackground,
    overflow: 'hidden',
    ...squircle,
  },
  segmentTop: { borderTopLeftRadius: radius.group, borderTopRightRadius: radius.group },
  segmentBottom: { borderBottomLeftRadius: radius.group, borderBottomRightRadius: radius.group },
  row: { flexDirection: 'row', alignItems: 'center', minHeight: HIT, paddingLeft: space.margin, gap: space.md },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingRight: space.margin,
    paddingVertical: 11,
    minHeight: HIT,
  },
  footerSlot: { paddingRight: space.margin, paddingBottom: space.md },
  sepLine: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.separator,
  },
  texts: { flex: 1, minWidth: 0 },
  title: { ...typo.body, color: c.label },
  subtitle: { ...typo.subheadline, color: c.secondaryLabel, marginTop: 1 },
  value: { ...typo.body, color: c.secondaryLabel, maxWidth: '55%' },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.full,
  },
  badgeDot: { width: 7, height: 7, borderRadius: 3.5 },
  badgeText: { ...typo.caption1, fontWeight: weight.semibold },
}));
