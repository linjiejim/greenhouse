/**
 * Low-level UI atoms: Icon (SF Symbols), Touchable (press feedback + haptics),
 * and Spinner (the native activity indicator).
 *
 * Icons are SF Symbols on iOS (rendered natively by expo-symbols — crisp at
 * every size, weight-matched to adjacent text, animatable) and the matching
 * Material Symbol on Android/web. Call sites use the semantic `IconName`; add
 * a new name here (both platforms) rather than passing raw symbol names around.
 * Navigation-bar items take SF names directly (`Stack.Toolbar.Button icon=`).
 */

import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  type ColorValue,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
  View,
} from 'react-native';
import { SymbolView, type SymbolViewProps, type SymbolWeight } from 'expo-symbols';
import { useTheme } from '../theme';
import { tapLight, tapMedium, selectionTick } from './haptics';

/* ----------------------------- Icon ----------------------------- */
type SFSymbol = Extract<SymbolViewProps['name'], string>;
type AndroidSymbolName = Exclude<Extract<SymbolViewProps['name'], object>['android'], undefined>;

/** Semantic icon name → [SF Symbol (iOS), Material Symbol (Android/web)]. */
const ICONS = {
  plus: ['plus', 'add'],
  up: ['arrow.up', 'arrow_upward'],
  stop: ['stop.fill', 'stop'],
  search: ['magnifyingglass', 'search'],
  chevR: ['chevron.right', 'chevron_right'],
  chevD: ['chevron.down', 'expand_more'],
  chevUpDown: ['chevron.up.chevron.down', 'unfold_more'],
  check: ['checkmark', 'check'],
  x: ['xmark', 'close'],
  book: ['book', 'menu_book'],
  books: ['books.vertical', 'menu_book'],
  globe: ['globe', 'public'],
  lock: ['lock', 'lock'],
  file: ['doc.text', 'description'],
  bar: ['chart.bar', 'bar_chart'],
  checkCircle: ['checkmark.circle', 'check_circle'],
  checkCircleFill: ['checkmark.circle.fill', 'check_circle'],
  pen: ['pencil', 'edit'],
  compose: ['square.and.pencil', 'edit_square'],
  copy: ['doc.on.doc', 'content_copy'],
  refresh: ['arrow.clockwise', 'refresh'],
  share: ['square.and.arrow.up', 'share'],
  sparkle: ['sparkles', 'auto_awesome'],
  brain: ['brain', 'psychology'],
  msg: ['bubble.left', 'chat_bubble'],
  msgs: ['bubble.left.and.bubble.right', 'forum'],
  folder: ['folder', 'folder'],
  gear: ['gearshape', 'settings'],
  menu: ['line.3.horizontal', 'menu'],
  expand: ['arrow.up.left.and.arrow.down.right', 'open_in_full'],
  rotate: ['arrow.counterclockwise', 'undo'],
  clock: ['clock', 'schedule'],
  camera: ['camera', 'photo_camera'],
  image: ['photo', 'image'],
  photos: ['photo.on.rectangle', 'image'],
  arrowDown: ['arrow.down', 'arrow_downward'],
  quote: ['quote.opening', 'format_quote'],
  tag: ['tag', 'sell'],
  tags: ['tag', 'label'],
  trash: ['trash', 'delete'],
  alert: ['exclamationmark.triangle', 'warning'],
  archive: ['archivebox', 'archive'],
  download: ['square.and.arrow.down', 'download'],
  list: ['list.bullet', 'list'],
  board: ['rectangle.split.3x1', 'view_column'],
  gantt: ['chart.bar.xaxis', 'view_timeline'],
  calendar: ['calendar', 'calendar_today'],
  users: ['person.2', 'group'],
  userPlus: ['person.badge.plus', 'person_add'],
  person: ['person.crop.circle', 'account_circle'],
  diamond: ['diamond', 'diamond'],
  activity: ['clock.arrow.circlepath', 'history'],
  foldAll: ['arrow.down.right.and.arrow.up.left', 'unfold_less'],
  circle: ['circle', 'circle'],
  eye: ['eye', 'visibility'],
  flag: ['flag', 'flag'],
  filter: ['line.3.horizontal.decrease', 'filter_list'],
  link: ['link', 'link'],
  open: ['arrow.up.right.square', 'open_in_new'],
  table: ['tablecells', 'table'],
  wrench: ['wrench.and.screwdriver', 'build'],
  person2: ['person', 'person'],
  // ── projects (task status, milestones, members, activity) ──
  statusProgress: ['circle.lefthalf.filled', 'contrast'],
  statusReview: ['eye.circle', 'rate_review'],
  statusCancelled: ['xmark.circle', 'cancel'],
  diamondFill: ['diamond.fill', 'diamond'],
  flagFill: ['flag.fill', 'flag'],
  subtask: ['arrow.turn.down.right', 'subdirectory_arrow_right'],
  personMinus: ['person.badge.minus', 'person_remove'],
  crown: ['crown', 'workspace_premium'],
  comment: ['text.bubble', 'comment'],
  folderPlus: ['folder.badge.plus', 'create_new_folder'],
  plusCircle: ['plus.circle', 'add_circle'],
  checklist: ['checklist', 'checklist'],
  hourglass: ['hourglass', 'hourglass_empty'],
} as const satisfies Record<string, readonly [SFSymbol, AndroidSymbolName]>;

export type IconName = keyof typeof ICONS;

/** The SF Symbol behind a semantic icon (for native toolbars / menus). */
export function sfSymbol(name: IconName): SFSymbol {
  return ICONS[name][0];
}

/**
 * An SF Symbol. Decorative by default: hidden from VoiceOver, so a row or
 * button reads only its text / `accessibilityLabel` (otherwise the symbol's
 * name — "gearshape.fill", "books.vertical" — gets glued into every label).
 * Pass `accessibilityLabel` only for the rare standalone icon that carries
 * meaning on its own (a status glyph with no text next to it).
 */
export function Icon({
  name,
  size = 20,
  color,
  weight = 'regular',
  type,
  animationSpec,
  style,
  accessibilityLabel,
}: {
  name: IconName;
  size?: number;
  color?: ColorValue;
  /** Match the weight of adjacent text (SF Symbols scale with it). */
  weight?: SymbolWeight;
  /** iOS rendering mode: monochrome (default) / hierarchical / palette / multicolor. */
  type?: SymbolViewProps['type'];
  /** iOS symbol effect (bounce, pulse, variable color…). */
  animationSpec?: SymbolViewProps['animationSpec'];
  style?: StyleProp<ViewStyle>;
  /** Makes the icon a VoiceOver element with this label (meaningful standalone icons only). */
  accessibilityLabel?: string;
}) {
  const { colors: c } = useTheme();
  const [ios, android] = ICONS[name];
  const symbol = (
    <SymbolView
      name={{ ios, android, web: android }}
      size={size}
      tintColor={color ?? c.label}
      weight={weight}
      type={type}
      animationSpec={animationSpec}
      style={{ width: size, height: size }}
    />
  );
  // The native symbol image would otherwise announce its SF name ("person.2")
  // to VoiceOver — a wrapper View is the reliable way to hide or label it.
  return accessibilityLabel ? (
    <View accessible accessibilityRole="image" accessibilityLabel={accessibilityLabel} style={style}>
      {symbol}
    </View>
  ) : (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={style}>
      {symbol}
    </View>
  );
}

/* ----------------------------- Touchable ----------------------------- */
/** iOS-style press feedback: a quick dim (no bouncy scale). */
const DEFAULT_PRESSED: ViewStyle = { opacity: 0.55 };

export function Touchable({
  children,
  onPress,
  onLongPress,
  haptic = 'none',
  disabled,
  style,
  pressedStyle = DEFAULT_PRESSED,
  hitSlop,
  delayLongPress,
  accessibilityRole,
  accessibilityLabel,
}: {
  children: React.ReactNode;
  onPress?: (e: GestureResponderEvent) => void;
  onLongPress?: () => void;
  /** haptic feedback fired on press (native-feeling default: none; long-press always ticks). */
  haptic?: 'light' | 'selection' | 'none';
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  /** style merged while pressed; pass {} to disable the default scale/dim. */
  pressedStyle?: StyleProp<ViewStyle>;
  hitSlop?: PressableProps['hitSlop'];
  delayLongPress?: number;
  accessibilityRole?: PressableProps['accessibilityRole'];
  /** Spoken label for icon-only buttons (no visible text). */
  accessibilityLabel?: string;
}) {
  const handlePress = (e: GestureResponderEvent) => {
    if (disabled) return;
    if (haptic === 'light') tapLight();
    else if (haptic === 'selection') selectionTick();
    onPress?.(e);
  };
  const handleLong = onLongPress
    ? () => {
        if (disabled) return;
        tapMedium();
        onLongPress();
      }
    : undefined;
  return (
    <Pressable
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress || onLongPress ? handlePress : undefined}
      onLongPress={handleLong}
      delayLongPress={delayLongPress}
      accessibilityRole={accessibilityRole}
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => [style, pressed && !disabled && pressedStyle]}
    >
      {children}
    </Pressable>
  );
}

/* ----------------------------- Spinner ----------------------------- */
/** The native activity indicator (UIActivityIndicatorView on iOS). */
export function Spinner({
  size = 'small',
  color,
  style,
}: {
  size?: 'small' | 'large';
  color?: ColorValue;
  style?: StyleProp<ViewStyle>;
}) {
  return <ActivityIndicator size={size} color={color} style={style} />;
}
