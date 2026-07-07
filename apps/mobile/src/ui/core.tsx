/**
 * Low-level UI atoms: Touchable (press feedback + haptics), Icon (lucide map),
 * Spinner (sage rotating arc) and Caret (streaming cursor).
 */

import React, { useEffect, useRef } from 'react';
import {
  Animated,
  Easing,
  Platform,
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import {
  AlertTriangle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  BarChart3,
  BookOpen,
  Brain,
  Camera,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clock,
  Copy,
  Download,
  FileText,
  Folder,
  Globe,
  Image as ImageIcon,
  Languages,
  Lock,
  LogOut,
  Maximize2,
  Menu,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Paperclip,
  PenLine,
  Plus,
  Quote,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings as SettingsIcon,
  Share2,
  Sparkles,
  Square,
  Tag,
  Tags,
  Trash2,
  X,
  Zap,
  type LucideIcon,
} from 'lucide-react-native';
import { useTheme } from '../theme';
import { tapLight, tapMedium, selectionTick } from './haptics';

/* ----------------------------- Icon ----------------------------- */
const ICONS = {
  plus: Plus,
  mic: Mic,
  up: ArrowUp,
  stop: Square,
  search: Search,
  chevR: ChevronRight,
  chevD: ChevronDown,
  chevL: ChevronLeft,
  check: Check,
  x: X,
  back: ArrowLeft,
  more: MoreHorizontal,
  book: BookOpen,
  globe: Globe,
  lock: Lock,
  file: FileText,
  bar: BarChart3,
  checkCircle: CheckCircle2,
  pen: PenLine,
  copy: Copy,
  refresh: RefreshCw,
  translate: Languages,
  share: Share2,
  pdf: FileText,
  sparkle: Sparkles,
  brain: Brain,
  bolt: Zap,
  msg: MessageSquare,
  server: Server,
  folder: Folder,
  gear: SettingsIcon,
  menu: Menu,
  logout: LogOut,
  expand: Maximize2,
  rotate: RotateCcw,
  clock: Clock,
  camera: Camera,
  image: ImageIcon,
  paperclip: Paperclip,
  arrowDown: ArrowDown,
  quote: Quote,
  tag: Tag,
  tags: Tags,
  trash: Trash2,
  alert: AlertTriangle,
  archive: Archive,
  download: Download,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 20,
  color,
  sw = 1.75,
}: {
  name: IconName;
  size?: number;
  color?: string;
  sw?: number;
}) {
  const { colors: c } = useTheme();
  const Cmp = ICONS[name];
  return <Cmp size={size} color={color ?? c.fg} strokeWidth={sw} />;
}

/* ----------------------------- Touchable ----------------------------- */
const DEFAULT_PRESSED: ViewStyle = { opacity: 0.85, transform: [{ scale: 0.97 }] };

export function Touchable({
  children,
  onPress,
  onLongPress,
  haptic = 'light',
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
  /** haptic feedback fired on press. */
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
export function Spinner({ size = 16, color }: { size?: number; color?: string }) {
  const { colors: themeColors } = useTheme();
  const resolved = color ?? themeColors.accent;
  const spin = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.timing(spin, { toValue: 1, duration: 800, easing: Easing.linear, useNativeDriver: true }),
    );
    loop.start();
    return () => loop.stop();
  }, [spin]);
  const rotate = spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  const stroke = Math.max(2, size * 0.16);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Svg width={size} height={size}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={themeColors.hairline} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={resolved}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * 0.72}
        />
      </Svg>
    </Animated.View>
  );
}

/* ----------------------------- Caret ----------------------------- */
export function Caret({ size = 16, color }: { size?: number; color?: string }) {
  const { colors: c } = useTheme();
  const resolved = color ?? c.accent;
  const op = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 0, duration: 1, delay: 480, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(op, { toValue: 1, duration: 1, delay: 480, useNativeDriver: Platform.OS !== 'web' }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [op]);
  return (
    <Animated.View
      style={{
        opacity: op,
        width: size * 0.5,
        height: size,
        marginLeft: 2,
        borderRadius: 2,
        backgroundColor: resolved,
        transform: [{ translateY: size * 0.18 }],
      }}
    />
  );
}
