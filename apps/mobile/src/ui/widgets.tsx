/**
 * Composite UI widgets shared across screens: avatars, chips, segmented
 * control, progress ring, empty state, thinking dots, toast, skeleton, plus the
 * Field / Button form atoms.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Easing,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type ViewStyle,
} from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { font, makeStyles, radius, shadow, space, useTheme, weight } from '../theme';
import { Caret, Icon, IconName, Touchable } from './core';

/* ----------------------------- Avatars ----------------------------- */
export function AiAvatar({ size = 34, rad = 10 }: { size?: number; rad?: number }) {
  const { colors: c } = useTheme();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: rad,
        backgroundColor: c.accentTint,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none">
        <Path
          d="M12 8c-4 0-6 3-6 6 0 4 3 6 6 6M12 8c4 0 6 3 6 6 0 4-3 6-6 6M12 4v18"
          stroke={c.accentDeep}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </View>
  );
}

export function UserAvatar({ size = 30, label = '我' }: { size?: number; label?: string }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: '#6b7a90',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text style={{ color: '#fff', fontSize: size * 0.42, fontWeight: '600' }}>{label}</Text>
    </View>
  );
}

/* ----------------------------- Chip ----------------------------- */
export function Chip({
  icon,
  label,
  active,
  onPress,
}: {
  icon?: IconName;
  label: string;
  active?: boolean;
  onPress?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable
      onPress={onPress}
      style={[styles.chip, { borderColor: active ? c.accentBorder : c.hairline, backgroundColor: active ? c.accentTint : c.surface }]}
    >
      {icon ? <Icon name={icon} size={15} color={active ? c.accent : c.fgMuted} /> : null}
      <Text style={{ fontSize: font.label, fontWeight: active ? '600' : '500', color: active ? c.accentDeep : c.fgSecondary }}>
        {label}
      </Text>
    </Touchable>
  );
}

/* ----------------------------- Segmented ----------------------------- */
export function Segmented<T extends string>({
  items,
  value,
  onChange,
  style,
}: {
  items: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const [w, setW] = useState(0);
  const idx = Math.max(0, items.findIndex((i) => i.id === value));
  const n = items.length;
  const segW = w > 0 ? (w - 6) / n : 0;
  const tx = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(tx, { toValue: idx * segW, useNativeDriver: true, speed: 20, bounciness: 4 }).start();
  }, [idx, segW, tx]);
  return (
    <View style={[styles.segWrap, style]} onLayout={(e) => setW(e.nativeEvent.layout.width)}>
      {segW > 0 && (
        <Animated.View style={[styles.segThumb, { width: segW, transform: [{ translateX: tx }] }]} />
      )}
      {items.map((it) => {
        const on = it.id === value;
        return (
          <Touchable key={it.id} haptic="selection" onPress={() => onChange(it.id)} pressedStyle={{ opacity: 0.7 }} style={styles.segItem}>
            <Text style={{ fontSize: font.small, fontWeight: on ? '600' : '500', color: on ? c.accentDeep : c.fgMuted }}>
              {it.label}
            </Text>
          </Touchable>
        );
      })}
    </View>
  );
}

/* ----------------------------- ProgressRing ----------------------------- */
export function ProgressRing({
  pct,
  size = 44,
  stroke = 4,
  color,
  showLabel = true,
}: {
  pct: number;
  size?: number;
  stroke?: number;
  color?: string;
  showLabel?: boolean;
}) {
  const { colors: themeColors } = useTheme();
  const resolved = color ?? themeColors.accent;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(100, pct)) / 100);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={{ transform: [{ rotate: '-90deg' }] }}>
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
          strokeDashoffset={off}
        />
      </Svg>
      {showLabel && (
        <Text style={{ position: 'absolute', fontSize: size * 0.26, fontWeight: '700', color: themeColors.fg }}>{pct}</Text>
      )}
    </View>
  );
}

/* ----------------------------- EmptyState ----------------------------- */
export function EmptyState({
  icon,
  title,
  sub,
  cta,
  onCta,
}: {
  icon: IconName;
  title: string;
  sub?: string;
  cta?: string;
  onCta?: () => void;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.empty}>
      <View style={styles.emptyIcon}>
        <Icon name={icon} size={30} color={c.fgFaint} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      {sub ? <Text style={styles.emptySub}>{sub}</Text> : null}
      {cta ? (
        <Touchable onPress={onCta} style={styles.emptyCta}>
          <Text style={{ color: c.onAccent, fontSize: font.label, fontWeight: '600' }}>{cta}</Text>
        </Touchable>
      ) : null}
    </View>
  );
}

/* ----------------------------- ThinkingDots ----------------------------- */
export function ThinkingDots() {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.dots}>
      {[0, 1, 2].map((i) => (
        <Dot key={i} delay={i * 180} />
      ))}
    </View>
  );
}
function Dot({ delay }: { delay: number }) {
  const { colors: c } = useTheme();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 600, delay, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0, duration: 600, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v, delay]);
  return (
    <Animated.View
      style={{
        width: 7,
        height: 7,
        borderRadius: 4,
        backgroundColor: c.accent,
        opacity: v.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }),
        transform: [{ translateY: v.interpolate({ inputRange: [0, 1], outputRange: [0, -3] }) }],
      }}
    />
  );
}

/* ----------------------------- Toast (presentational) ----------------------------- */
export function Toast({ message }: { message: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const a = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(a, { toValue: 1, useNativeDriver: true, speed: 18, bounciness: 8 }).start();
  }, [a]);
  return (
    <Animated.View
      style={[styles.toast, { opacity: a, transform: [{ scale: a.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) }] }]}
    >
      <Icon name="check" size={16} color={c.accent} sw={2.6} />
      <Text style={styles.toastText}>{message}</Text>
    </Animated.View>
  );
}

/* ----------------------------- Skeleton ----------------------------- */
export function Skeleton({ style }: { style?: StyleProp<ViewStyle> }) {
  const { colors: c } = useTheme();
  const v = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(v, { toValue: 0.5, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [v]);
  return <Animated.View style={[{ backgroundColor: c.surfaceMuted, borderRadius: 6, opacity: v }, style]} />;
}

/* ----------------------------- Field + Button ----------------------------- */
export const Field = React.forwardRef<TextInput, TextInputProps & { icon?: IconName }>(function Field(
  { icon, style, ...props },
  ref,
) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.field}>
      {icon ? <Icon name={icon} size={19} color={c.fgMuted} /> : null}
      <TextInput ref={ref} placeholderTextColor={c.fgFaint} style={[styles.fieldInput, style]} {...props} />
    </View>
  );
});

export function Button({
  label,
  onPress,
  loading,
  disabled,
  variant = 'primary',
}: {
  label: string;
  onPress?: () => void;
  loading?: boolean;
  disabled?: boolean;
  variant?: 'primary' | 'muted' | 'danger';
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const isDisabled = disabled || loading;
  const bg = variant === 'primary' ? c.accent : variant === 'danger' ? c.danger : c.surfaceMuted;
  const fg = variant === 'muted' ? c.fgFaint : variant === 'primary' ? c.onAccent : '#fff';
  return (
    <Touchable
      onPress={isDisabled ? undefined : onPress}
      disabled={isDisabled}
      pressedStyle={{ opacity: 0.85 }}
      style={[styles.btn, { backgroundColor: bg }, variant === 'primary' && !isDisabled && shadow.accent]}
    >
      {loading ? (
        <ActivityIndicator color={fg} />
      ) : (
        <Text style={{ color: fg, fontSize: font.title, fontWeight: '600', letterSpacing: variant === 'primary' ? 2 : 0 }}>{label}</Text>
      )}
    </Touchable>
  );
}

/* ----------------------------- Tile (leading icon) ----------------------------- */
/** The one leading icon tile — a tinted rounded square. `tint` selects the
 *  fill/foreground pairing; `size` defaults to the 36px used in list rows. */
export function Tile({
  icon,
  size = 36,
  iconSize,
  tint = 'accent',
}: {
  icon: IconName;
  size?: number;
  iconSize?: number;
  tint?: 'accent' | 'muted' | 'danger';
}) {
  const { colors: c } = useTheme();
  const bg = tint === 'danger' ? c.dangerTint : tint === 'muted' ? c.surfaceMuted : c.accentTint;
  const fg = tint === 'danger' ? c.danger : tint === 'muted' ? c.fgMuted : c.accentDeep;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius.tile,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Icon name={icon} size={iconSize ?? Math.round(size * 0.5)} color={fg} />
    </View>
  );
}

/* ----------------------------- DisclosureRow ----------------------------- */
/** The quiet, tappable trigger shared by the assistant reply's tool-calls,
 *  references, reasoning and metrics rows: a small leading icon, a muted label,
 *  and a trailing chevron (right, or down when `open`). One row, one look. */
export function DisclosureRow({
  icon,
  label,
  open,
  trailing = 'chevron',
  onPress,
  style,
}: {
  icon: IconName;
  label: string;
  /** When set, the chevron flips down (true) / right (false) — for toggles. */
  open?: boolean;
  trailing?: 'chevron' | 'none';
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable haptic="none" onPress={onPress} style={[styles.disclosure, style]}>
      <Icon name={icon} size={15} color={c.fgMuted} />
      <Text style={styles.disclosureLabel}>{label}</Text>
      {trailing === 'chevron' ? <Icon name={open ? 'chevD' : 'chevR'} size={14} color={c.fgFaint} /> : null}
    </Touchable>
  );
}

/* ----------------------------- ScreenHeader ----------------------------- */
/**
 * The two header archetypes, unified. `variant="large"` is the top-level list
 * header (settings / knowledge): a back button and a big 28px title. `"compact"`
 * is the detail header (chat / doc / table): a leading button, a centered (or
 * left) title with optional subtitle + streaming caret, and an optional trailing
 * slot, over a bottom hairline. Screens still own their safe-area top padding.
 */
export function ScreenHeader({
  title,
  subtitle,
  variant = 'compact',
  align = 'center',
  leading = 'back',
  onLeading,
  right,
  bordered = false,
  titleStreaming = false,
}: {
  title: string;
  subtitle?: string;
  variant?: 'large' | 'compact';
  align?: 'left' | 'center';
  leading?: 'back' | 'close' | 'none';
  onLeading?: () => void;
  right?: React.ReactNode;
  bordered?: boolean;
  titleStreaming?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const lead =
    leading === 'none' ? null : (
      <Touchable haptic="none" onPress={onLeading} style={styles.headerBtn} hitSlop={8}>
        <Icon name={leading === 'close' ? 'x' : 'back'} size={variant === 'large' ? 23 : 22} color={c.fg} />
      </Touchable>
    );

  if (variant === 'large') {
    return (
      <View style={styles.headerLarge}>
        {lead}
        <Text style={styles.headerLargeTitle}>{title}</Text>
        {right ? <View style={{ marginLeft: 'auto' }}>{right}</View> : null}
      </View>
    );
  }

  return (
    <View style={[styles.headerCompact, bordered && styles.headerBordered]}>
      {lead ?? <View style={styles.headerBtn} />}
      <View style={[styles.headerCenter, { alignItems: align === 'center' ? 'center' : 'flex-start' }]}>
        <View style={styles.headerTitleRow}>
          <Text numberOfLines={1} style={[styles.headerCompactTitle, titleStreaming && { opacity: 0.5 }]}>
            {title}
          </Text>
          {titleStreaming ? <Caret size={14} /> : null}
        </View>
        {subtitle ? <Text style={styles.headerSub}>{subtitle}</Text> : null}
      </View>
      {right ? right : align === 'center' ? <View style={styles.headerBtn} /> : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 8,
    paddingLeft: 12,
    paddingRight: 14,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  segWrap: {
    flexDirection: 'row',
    backgroundColor: c.surfaceMuted,
    borderRadius: radius.md,
    padding: 3,
    position: 'relative',
  },
  segThumb: {
    position: 'absolute',
    top: 3,
    bottom: 3,
    left: 3,
    backgroundColor: c.surface,
    borderRadius: 7,
    ...Platform.select({
      ios: { shadowColor: '#111827', shadowOpacity: 0.12, shadowRadius: 2, shadowOffset: { width: 0, height: 1 } },
      android: { elevation: 1 },
    }),
  },
  segItem: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 6 },

  disclosure: { flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' },
  disclosureLabel: { fontSize: font.small, color: c.fgMuted, fontWeight: weight.medium },

  headerBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  headerLarge: { flexDirection: 'row', alignItems: 'center', gap: 2, paddingHorizontal: 16, paddingBottom: 8 },
  headerLargeTitle: { fontSize: font.displaySm, fontWeight: weight.bold, color: c.fg, letterSpacing: -0.5, marginLeft: -2 },
  headerCompact: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingBottom: 10 },
  headerBordered: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.hairline },
  headerCenter: { flex: 1 },
  headerTitleRow: { flexDirection: 'row', alignItems: 'center' },
  headerCompactTitle: { fontSize: font.title, fontWeight: weight.bold, color: c.fg, maxWidth: 240 },
  headerSub: { fontSize: font.caption, color: c.fgMuted, marginTop: 1 },

  empty: { alignItems: 'center', justifyContent: 'center', paddingVertical: 60, paddingHorizontal: 32 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 18,
    backgroundColor: c.surfaceMuted,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  emptyTitle: { fontSize: font.title, fontWeight: '600', color: c.fg },
  emptySub: { fontSize: font.small, color: c.fgMuted, lineHeight: 20, textAlign: 'center', marginTop: 4, maxWidth: 240 },
  emptyCta: {
    marginTop: 16,
    paddingVertical: 10,
    paddingHorizontal: 18,
    borderRadius: radius.full,
    backgroundColor: c.accent,
  },

  dots: { flexDirection: 'row', gap: 5, paddingVertical: 6, paddingHorizontal: 2 },

  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(17,24,39,0.92)',
    paddingVertical: 11,
    paddingHorizontal: 18,
    borderRadius: radius.full,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: 0.28, shadowRadius: 24, shadowOffset: { width: 0, height: 8 } },
      android: { elevation: 8 },
    }),
  },
  toastText: { color: '#fff', fontSize: font.label, fontWeight: '500' },

  field: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    height: 50,
    paddingHorizontal: 14,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: c.hairline,
    backgroundColor: c.surface,
  },
  fieldInput: { flex: 1, fontSize: font.body, color: c.fg, padding: 0 },

  btn: { height: 50, borderRadius: radius.lg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: space.lg },
}));
