/**
 * iOS list building blocks for React Native–rendered lists.
 *
 * Use these when a list needs RN content (pagination, rich rows, tag chips,
 * custom drawing) — they reproduce UIKit's inset-grouped / plain list
 * geometry exactly: 44-pt minimum rows, 16-pt margins, separators inset to the
 * text (not under the icon), continuous-corner sections, `systemFill` press
 * highlight, secondary text in `secondaryLabel`, disclosure chevrons in
 * `tertiaryLabel`.
 *
 * Pure settings-style screens (toggles, pickers, text fields, plain choices)
 * should use real SwiftUI instead — `@expo/ui/swift-ui` `Form` / `Section`
 * inside a `Host` (see src/ui/native-form.tsx).
 *
 *  - `ListSection` — a group with optional header/footer. `inset` (default)
 *    = rounded card on `groupedBackground`; `plain` = full-bleed rows.
 *  - `ListRow` — leading icon tile or custom view, title + optional subtitle,
 *    trailing value / chevron / checkmark / custom accessory, optional
 *    `footer` slot under the row (expanded details). Long-press menus come
 *    from wrapping in `NativeMenu trigger="longPress"` (mirror the menu's
 *    actions in `accessibilityActions` for VoiceOver); a row that is the
 *    trigger of a `NativeMenu trigger="tap"` sets `menuTrigger`. Only an
 *    explicit `disabled` reads as dimmed — a row without `onPress` is just
 *    not tappable here.
 *  - Virtualized lists (FlatList / SectionList) can't wrap rows in a
 *    `ListSection`: give each row its `position` ('first' | 'middle' | 'last'
 *    | 'only') and it draws its own slice of the inset card (outer corners,
 *    no separator under the last). Section titles: `ListSectionHeader` /
 *    `ListSectionFooter`; a free-form card: `ListCard`.
 *  - `IconTile` — the rounded colored square behind a row icon (Settings-style).
 *  - `Badge` — a small capsule label (状态, 当前, a category) in a system tone
 *    or a data-driven color. Don't restyle capsules per screen.
 *
 * Custom row layouts (Mail-style multi-line rows) should still use the same
 * constants: `LIST_TILE` leading width and `separatorInset()`.
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

/** Default leading tile size (Settings-style icon tile). */
export const LIST_TILE = 30;
const TILE = LIST_TILE;

/** Separator / footer inset from the row's leading edge: aligns with the text. */
export function separatorInset(leadingWidth?: number): number {
  return leadingWidth ? space.margin + leadingWidth + space.md : space.margin;
}

export type RowPosition = 'first' | 'middle' | 'last' | 'only';

export function ListSectionHeader({
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

export function ListSectionFooter({ text, style }: { text: string; style?: StyleProp<TextStyle> }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return <Text style={[styles.footer, styles.outerInset, style]}>{text}</Text>;
}

/** The inset-grouped card surface for custom content (16-pt outer margin, group radius). */
export function ListCard({ children, style }: { children: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return <View style={[styles.insetCard, styles.outerInset, style]}>{children}</View>;
}

export function ListSection({
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
          React.cloneElement(row as React.ReactElement<ListRowProps>, {
            key: row.key ?? i,
            last: i === rows.length - 1,
          }),
        )}
      </View>
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

export interface ListRowProps {
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
  /** Set by ListSection — hides the separator under the last row. */
  last?: boolean;
}

export function ListRow({
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
  menuTrigger,
  accessibilityLabel,
  accessibilityActions,
  onAccessibilityAction,
  position,
  last,
}: ListRowProps) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const inset = separatorInset(icon ? TILE : leading ? (leadingWidth ?? TILE) : undefined);
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
      <Row
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
        <View style={styles.body}>
          <View style={styles.texts}>
            <Text numberOfLines={titleLines} style={[styles.title, destructive && { color: c.red }]}>
              {title}
            </Text>
            {subtitle ? (
              <Text numberOfLines={subtitleLines} style={styles.subtitle}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {value ? (
            <Text numberOfLines={1} style={styles.value}>
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
      </Row>
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
function Row({
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
  ListRowProps,
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
        { ...typo.subheadline, fontWeight: weight.medium, color: c.accent, paddingHorizontal: space.margin, paddingBottom: space.sm }
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
