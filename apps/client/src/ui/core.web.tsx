/**
 * Low-level UI atoms: Icon (SF Symbols), Touchable (press feedback + haptics),
 * and Spinner (the native activity indicator).
 *
 * Icons are SF Symbols on iOS (rendered natively by expo-symbols — crisp at
 * every size, weight-matched to adjacent text, animatable) and the matching
 * Material Symbol on Android/web. Call sites use the semantic `IconName`; add
 * a new name here (both platforms) rather than passing raw symbol names around.
 * Navigation-bar items take `toolbarIcon(name)` (src/ui/toolbar-icon.ts) — an
 * SF Symbol on iOS, a generated vector drawable on Android (after adding a
 * name here, re-run `scripts/android-icons.py`).
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
import type { SymbolViewProps, SymbolWeight } from 'expo-symbols';
import { webIcons } from './icon-map';
import { useTheme } from '../theme';
import { tapLight, tapMedium, selectionTick } from './haptics';

/* ----------------------------- Icon ----------------------------- */
type SFSymbol = Extract<SymbolViewProps['name'], string>;
type AndroidSymbolName = Exclude<Extract<SymbolViewProps['name'], object>['android'], undefined>;

/** Semantic icon name → [SF Symbol (iOS), Material Symbol (Android/web)]. */
const ICONS = {
  mic: ['mic', 'mic'],
  speaker: ['speaker.wave.2', 'volume_up'],
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
  globe: ['globe', 'public'],
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
  msg: ['bubble.left', 'chat_bubble'],
  msgs: ['bubble.left.and.bubble.right', 'forum'],
  folder: ['folder', 'folder'],
  gear: ['gearshape', 'settings'],
  menu: ['line.3.horizontal', 'menu'],
  expand: ['arrow.up.left.and.arrow.down.right', 'open_in_full'],
  rotate: ['arrow.counterclockwise', 'undo'],
  sideways: ['rectangle.landscape.rotate', 'screen_rotation'],
  clock: ['clock', 'schedule'],
  camera: ['camera', 'photo_camera'],
  image: ['photo', 'image'],
  photos: ['photo.on.rectangle', 'image'],
  arrowDown: ['arrow.down', 'arrow_downward'],
  quote: ['quote.opening', 'format_quote'],
  trash: ['trash', 'delete'],
  alert: ['exclamationmark.triangle', 'warning'],
  archive: ['archivebox', 'archive'],
  download: ['square.and.arrow.down', 'download'],
  users: ['person.2', 'group'],
  userPlus: ['person.badge.plus', 'person_add'],
  person: ['person.crop.circle', 'account_circle'],
  circle: ['circle', 'circle'],
  filter: ['line.3.horizontal.decrease', 'filter_list'],
  filterOn: ['line.3.horizontal.decrease.circle.fill', 'filter_alt'],
  // the overflow "more" button: horizontal on iOS, vertical (⋮) on Android
  more: ['ellipsis', 'more_vert'],
  link: ['link', 'link'],
  server: ['server.rack', 'dns'],
  logout: ['rectangle.portrait.and.arrow.right', 'logout'],
  open: ['arrow.up.right.square', 'open_in_new'],
  table: ['tablecells', 'table'],
  wrench: ['wrench.and.screwdriver', 'build'],
  // ── steps, people, comments, waiting ──
  statusProgress: ['circle.lefthalf.filled', 'contrast'],
  statusCancelled: ['xmark.circle', 'cancel'],
  personMinus: ['person.badge.minus', 'person_remove'],
  comment: ['text.bubble', 'comment'],
  hourglass: ['hourglass', 'hourglass_empty'],
  // ── rich replies (forms, artifacts, diagrams) ──
  send: ['paperplane', 'send'],
  form: ['list.bullet.clipboard', 'assignment'],
  branch: ['arrow.triangle.branch', 'call_split'],
  code: ['chevron.left.forwardslash.chevron.right', 'code'],
  diagram: ['point.3.connected.trianglepath.dotted', 'account_tree'],
  attach: ['paperclip', 'attach_file'],
  // ── conversations (pinned row, 「需要你」 cards, sign-in, mentions) ──
  pin: ['pin.fill', 'push_pin'],
  pinOff: ['pin.slash', 'keep_off'],
  hand: ['hand.raised', 'front_hand'],
  shieldCheck: ['checkmark.shield', 'verified_user'],
  key: ['key.fill', 'key'],
  sleep: ['moon.zzz', 'bedtime'],
  at: ['at', 'alternate_email'],
  alertCircle: ['exclamationmark.circle', 'error'],
  // rating a reply (the filled one marks the rating given)
  thumbUp: ['hand.thumbsup', 'thumb_up'],
  thumbUpFill: ['hand.thumbsup.fill', 'thumb_up'],
  thumbDown: ['hand.thumbsdown', 'thumb_down'],
  thumbDownFill: ['hand.thumbsdown.fill', 'thumb_down'],
  // ── an Agent's computer (screen, keys, zoom) ──
  computer: ['desktopcomputer', 'computer'],
  keyboard: ['keyboard', 'keyboard'],
  zoomIn: ['plus.magnifyingglass', 'zoom_in'],
  zoomOut: ['minus.magnifyingglass', 'zoom_out'],
  // ── v2 shell (notifications, runs, skills) ──
  bell: ['bell', 'notifications'],
  bellBadge: ['bell.badge', 'notifications_unread'],
  bellSlash: ['bell.slash', 'notifications_off'],
  runs: ['waveform.path.ecg', 'vital_signs'],
  wand: ['wand.and.stars', 'auto_fix_high'],
  // ── 3.0: tabs, library actions, file kinds, text size ──
  home: ['house', 'home'],
  cloud: ['cloud', 'cloud'],
  checklist: ['checklist', 'checklist'],
  folderPlus: ['folder.badge.plus', 'create_new_folder'],
  docPlus: ['doc.badge.plus', 'note_add'],
  moveTo: ['arrow.turn.up.right', 'drive_file_move'],
  pdf: ['doc.richtext', 'picture_as_pdf'],
  sheet: ['tablecells', 'table_chart'],
  slides: ['play.rectangle', 'slideshow'],
  video: ['film', 'movie'],
  audio: ['waveform', 'audio_file'],
  text: ['doc.plaintext', 'article'],
  fileOther: ['doc', 'draft'],
  textSize: ['textformat.size', 'format_size'],
  chevL: ['chevron.left', 'chevron_left'],
  chevU: ['chevron.up', 'expand_less'],
  // ── 4.0: app (plugin) icons ──
  apps: ['square.grid.2x2', 'apps'],
  brain: ['brain', 'psychology'],
  mail: ['envelope', 'mail'],
  calendar: ['calendar', 'calendar_month'],
  note: ['note.text', 'sticky_note_2'],
  chart: ['chart.pie', 'pie_chart'],
  cart: ['cart', 'shopping_cart'],
  box: ['shippingbox', 'inventory_2'],
  building: ['building.2', 'apartment'],
  upload: ['square.and.arrow.up.on.square', 'upload'],
  grid: ['square.grid.2x2', 'grid_view'],
  list: ['list.bullet', 'view_list'],
  // ── 4.0: the Admin place ──
  pricing: ['dollarsign.circle', 'paid'],
  sliders: ['slider.horizontal.3', 'tune'],
  plug: ['powerplug', 'power'],
  palette: ['paintpalette', 'palette'],
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
  type: _type,
  animationSpec: _animationSpec,
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
  const Glyph = webIcons[name];
  const symbol = (
    <Glyph
      size={size}
      color={String(color ?? c.label)}
      strokeWidth={weight === 'bold' ? 2.5 : 1.8}
      aria-hidden="true"
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
  accessibilityState,
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
  accessibilityState?: PressableProps['accessibilityState'];
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
  // A passive Chip must not install PressResponder: it consumes clicks even
  // without onPress, preventing its containing row from opening the record.
  const accessibility = {
    accessibilityRole,
    accessibilityLabel,
    'aria-busy': accessibilityState?.busy,
    'aria-checked': accessibilityState?.checked,
    'aria-expanded': accessibilityState?.expanded,
    'aria-selected': accessibilityState?.selected,
    'aria-disabled': !!disabled,
  };
  if (!onPress && !onLongPress)
    return (
      <View {...accessibility} style={style}>
        {children}
      </View>
    );
  return (
    <Pressable
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={onPress || onLongPress ? handlePress : undefined}
      onLongPress={handleLong}
      delayLongPress={delayLongPress}
      {...accessibility}
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
