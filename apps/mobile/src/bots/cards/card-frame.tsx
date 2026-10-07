/**
 * The pieces every "needs you" card shares (spec docs/specs/20261008-mobile-bots.md
 * §2.5.4): the frame (a content-layer solid card — never glass), the decision
 * buttons, the action hook that turns a button into a decision, and the
 * small text blocks the kind bodies are built from. Pure RN + `NativeButton`,
 * so the same cards render on Android (its NativeButton is Material).
 *
 * Feedback (one rule per outcome): a decision that went through gets the
 * success haptic and the card flips to its receipt on its own (the host's
 * state — thread engine or store — carries the result); one settled elsewhere
 * (`stale`) is silent — the host re-reads and the card shows what happened;
 * one the server could not carry out (`refused`) keeps the card pending and
 * says why in a system alert.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Pressable,
  Text,
  useWindowDimensions,
  View,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withTiming,
} from 'react-native-reanimated';
import type { BotApprovalPayload, BotCreatePayload, BotRequestDecision, BotRequestView } from '../../shared/bots';
import { useT, type TFunction } from '../../lib/i18n';
import { useAuth } from '../../store/auth';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { NativeButton } from '../../ui/button';
import { Icon, Touchable, type IconName } from '../../ui/core';
import { alertError, confirmAction } from '../../ui/dialogs';
import { notifySuccess } from '../../ui/haptics';
import { Badge, IconTile, type BadgeTone } from '../../ui/list';
import type { DecideOutcome } from '../contract';
import { useBots } from '../store';
import { validateBotName } from '../vendor/bot-name';
import {
  alwaysSite,
  buttonLabel,
  cardButtons,
  cardKind,
  decisionFor,
  refusalCopy,
  type CardButton,
  type Copy,
} from './decision';

/**
 * Above this Dynamic Type scale the buttons stack full-width and an info row's
 * label sits above its value (HIG: never squeeze a label).
 */
const STACK_FONT_SCALE = 1.35;
/** How long a deep-linked card stays highlighted. */
const HIGHLIGHT_MS = 1200;

export function tr(t: TFunction, copy: Copy): string {
  return t(copy.key, copy.vars);
}

/**
 * A Bot's display name for card copy. Before the directory has answered, a
 * neutral "Your Bot" — never "Deleted Bot" for an id we simply have not heard
 * about yet; no Bot at all (a card the computer raised) reads the same.
 */
export function useBotName(botId: string | null): string {
  const t = useT();
  const bot = useBots((s) => (botId ? s.byId[botId] : undefined));
  const loaded = useBots((s) => s.botsLoaded);
  if (bot) return bot.name;
  return botId && loaded ? t('bots.common.deletedBot') : t('bots.card.aBot');
}

// ─── Highlight ───────────────────────────────────────────

/**
 * The accent wash a deep-linked card (`?request=`) gets: on, then faded out
 * over `HIGHLIGHT_MS`. Reduce Motion: on, then off — no fade.
 */
function useHighlight(highlighted: boolean | undefined) {
  const reduceMotion = useReducedMotion();
  const wash = useSharedValue(0);
  const [still, setStill] = useState(false);
  useEffect(() => {
    if (!highlighted) return;
    if (reduceMotion) {
      setStill(true);
      const timer = setTimeout(() => setStill(false), HIGHLIGHT_MS);
      return () => clearTimeout(timer);
    }
    wash.value = withSequence(
      withTiming(1, { duration: 0 }),
      withDelay(HIGHLIGHT_MS / 2, withTiming(0, { duration: HIGHLIGHT_MS / 2 })),
    );
    return undefined;
  }, [highlighted, reduceMotion, wash]);
  const animated = useAnimatedStyle(() => ({ opacity: wash.value }));
  return reduceMotion ? { opacity: still ? 1 : 0 } : animated;
}

/** The highlight layer over a card / receipt (absolute, never intercepts touches). */
export function HighlightWash({ highlighted, radius: r }: { highlighted?: boolean; radius: number }) {
  const { colors: c } = useTheme();
  const style = useHighlight(highlighted);
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: r, backgroundColor: c.accentFill },
        squircle,
        style,
      ]}
    />
  );
}

// ─── Frame ───────────────────────────────────────────────

/**
 * The card: kind icon tile, headline and status badge on top; the body; the
 * footer (countdown + buttons, or "Ask Again"). `onHeaderPress` makes the
 * header a button — an expanded receipt collapses back through it.
 */
export function CardFrame({
  icon,
  title,
  badge,
  settled,
  highlighted,
  onHeaderPress,
  headerHint,
  children,
  footer,
  style,
}: {
  icon: IconName;
  title: string;
  badge: { label: string; tone: BadgeTone };
  /** A settled card dims its tile to gray (the decision is over). */
  settled?: boolean;
  highlighted?: boolean;
  onHeaderPress?: () => void;
  /** VoiceOver hint for the header button. */
  headerHint?: string;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const header = (
    <View style={styles.header}>
      <IconTile icon={icon} tint={settled ? c.gray : undefined} />
      <Text style={styles.title} accessibilityRole="header">
        {title}
      </Text>
      <Badge label={badge.label} tone={badge.tone} style={styles.badge} />
    </View>
  );
  return (
    <View style={[styles.card, style]}>
      <HighlightWash highlighted={highlighted} radius={radius.group} />
      {onHeaderPress ? (
        <Pressable
          onPress={onHeaderPress}
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${badge.label}`}
          accessibilityHint={headerHint}
          accessibilityState={{ expanded: true }}
          style={({ pressed }) => (pressed ? { opacity: 0.55 } : null)}
        >
          {header}
        </Pressable>
      ) : (
        header
      )}
      {children ? <View style={styles.body}>{children}</View> : null}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
    </View>
  );
}

// ─── Buttons ─────────────────────────────────────────────

/**
 * The card's decision buttons (`cardButtons`): a trailing row with the
 * prominent one last, wrapping when the labels do not fit; at large Dynamic
 * Type sizes a full-width stack with the prominent one on top. While a
 * decision is in flight its button spins and the others wait.
 */
export function DecisionBar({
  request,
  name,
  busy,
  onPress,
}: {
  request: BotRequestView;
  name: string;
  busy: CardButton['id'] | null;
  onPress: (button: CardButton) => void;
}) {
  const t = useT();
  const { fontScale } = useWindowDimensions();
  const buttons = cardButtons(request);
  if (buttons.length === 0) return null;
  const stacked = fontScale > STACK_FONT_SCALE;
  const ordered = stacked ? [...buttons].reverse() : buttons;
  return (
    <View
      style={
        stacked
          ? { alignSelf: 'stretch', gap: space.sm }
          : { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space.sm }
      }
    >
      {ordered.map((button) => (
        <NativeButton
          key={button.id}
          label={tr(t, buttonLabel(request, button.id, name))}
          variant={button.prominent ? 'prominent' : 'tinted'}
          fullWidth={stacked}
          style={stacked ? { alignSelf: 'stretch' } : undefined}
          loading={busy === button.id}
          disabled={busy !== null && busy !== button.id}
          onPress={() => onPress(button)}
        />
      ))}
    </View>
  );
}

/**
 * Turns a button into what it does: open the sign-in / Bot form sheet, ask
 * first (always-allow, "I've done it"), or post the decision through
 * `onDecide` (the thread's `ctl.decide`, the needs-you sheet's
 * `useBots.decide`) and give the outcome its feedback. `press` resolves to the
 * outcome (null when nothing was posted) so a sheet can close on `ok` / `stale`.
 */
export function useCardActions({
  request,
  sessionId,
  name,
  onDecide,
}: {
  request: BotRequestView;
  sessionId: string;
  name: string;
  onDecide: (body: BotRequestDecision) => Promise<DecideOutcome>;
}): { busy: CardButton['id'] | null; press: (button: CardButton) => Promise<DecideOutcome | null> } {
  const t = useT();
  const router = useRouter();
  const [busy, setBusy] = useState<CardButton['id'] | null>(null);
  // A second tap while the first decision is in flight (state updates are async).
  const inFlight = useRef(false);

  const press = useCallback(
    async (button: CardButton): Promise<DecideOutcome | null> => {
      if (inFlight.current) return null;
      if (button.id === 'signIn') {
        router.push({ pathname: '/bots/login', params: { id: request.id, c: sessionId } });
        return null;
      }
      const editProposal = () => router.push({ pathname: '/bots/bot-form', params: { request: request.id } });
      if (button.id === 'edit') {
        editProposal();
        return null;
      }
      if (button.id === 'approve' && cardKind(request) === 'bot_create') {
        // A name the server would refuse (taken, reserved, the member's own): fix it in the form first.
        const proposal = request.payload as BotCreatePayload;
        const { bots } = useBots.getState();
        const issue = validateBotName(proposal.name ?? '', {
          otherNames: bots.map((bot) => bot.name),
          nickname: useAuth.getState().user?.nickname ?? null,
        });
        if (issue) {
          editProposal();
          return null;
        }
      }
      if (button.confirm && !(await confirmFor(t, request, button, name))) return null;
      const body = decisionFor(button.id);
      if (!body) return null;
      inFlight.current = true;
      setBusy(button.id);
      try {
        const outcome = await onDecide(body);
        if (outcome.kind === 'ok') notifySuccess();
        else if (outcome.kind === 'refused') {
          const copy = refusalCopy(outcome);
          alertError(t('bots.card.failedTitle'), 'text' in copy ? copy.text : tr(t, copy));
        }
        return outcome;
      } finally {
        inFlight.current = false;
        setBusy(null);
      }
    },
    [name, onDecide, request, router, sessionId, t],
  );
  return { busy, press };
}

/** The question behind a `confirm` button, written out with its scope. */
function confirmFor(t: TFunction, request: BotRequestView, button: CardButton, name: string): Promise<boolean> {
  if (button.id === 'always') {
    const site = alwaysSite(request.payload as BotApprovalPayload) ?? t('bots.card.thisSite');
    return confirmAction({
      title: t('bots.card.alwaysTitle', { site }),
      message: t('bots.card.alwaysBody', { name }),
      confirmLabel: t('bots.card.alwaysConfirm'),
    });
  }
  return confirmAction({ title: t('bots.card.finishedConfirm', { name }), confirmLabel: t('bots.card.finished') });
}

// ─── Text blocks ─────────────────────────────────────────

/**
 * A "label · value" line (a detail row, the site / page of a sign-in). The
 * label is never cut — approval labels are the server's raw input keys
 * (`spreadsheet_id`): a flexible column (72 pt up to 40% of the row) at
 * regular sizes, its own line above the value at large Dynamic Type.
 */
export function InfoRow({
  label,
  value,
  lines,
  icon,
  note,
  selectable,
}: {
  label: string;
  value: string;
  /** Lines before the value truncates; omitted = the whole value. */
  lines?: number;
  icon?: IconName;
  /** A quiet note after the value (the server cut it: "…120 more characters"). */
  note?: string;
  selectable?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { fontScale } = useWindowDimensions();
  const stacked = fontScale > STACK_FONT_SCALE;
  return (
    <View
      style={stacked ? styles.infoStack : styles.infoRow}
      accessible
      accessibilityLabel={`${label}: ${value}${note ? ` ${note}` : ''}`}
    >
      <Text style={stacked ? styles.infoLabelStacked : styles.infoLabel}>{label}</Text>
      <View style={[styles.infoValueWrap, stacked && styles.infoValueWrapStacked]}>
        {icon ? <Icon name={icon} size={13} color={c.secondaryLabel} style={styles.infoIcon} /> : null}
        <Text style={styles.infoValue} numberOfLines={lines} selectable={selectable} ellipsizeMode="tail">
          {value}
          {note ? <Text style={styles.infoNote}>{` ${note}`}</Text> : null}
        </Text>
      </View>
    </View>
  );
}

/** A quiet explanation under the body (why the phone can only skip, what a sign-in is for). */
export function CardNote({ text, tone }: { text: string; tone?: ColorValue }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return <Text style={[styles.note, tone ? { color: tone } : null]}>{text}</Text>;
}

/**
 * A text link under a card's body: "View All ›" / "View Changes ›" open the
 * card sheet with everything the card leaves out (`opens`); "Show More ⌄"
 * expands in place (`expands`, `expanded` flips the chevron).
 */
export function MoreLink({
  label,
  onPress,
  expands,
  expanded,
}: {
  label: string;
  onPress: () => void;
  expands?: boolean;
  expanded?: boolean;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <Touchable onPress={onPress} accessibilityRole="button" accessibilityLabel={label} style={styles.more} hitSlop={8}>
      <Text style={styles.moreText}>{label}</Text>
      <Icon
        name={expands ? 'chevD' : 'chevR'}
        size={12}
        weight="semibold"
        color={c.accentText}
        style={expands && expanded ? { transform: [{ rotate: '180deg' }] } : undefined}
      />
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.group,
    padding: space.lg,
    gap: space.md,
    overflow: 'hidden',
    ...squircle,
  },
  header: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  title: { ...typo.headline, color: c.label, flex: 1 },
  badge: { alignSelf: 'flex-start', marginTop: 2 },
  body: { gap: space.sm },
  footer: { gap: space.sm },
  infoRow: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  infoStack: { gap: space.xxs },
  infoLabel: { ...typo.footnote, color: c.secondaryLabel, minWidth: 72, maxWidth: '40%', flexShrink: 0, paddingTop: 2 },
  infoLabelStacked: { ...typo.footnote, color: c.secondaryLabel },
  infoValueWrap: { flex: 1, flexDirection: 'row', alignItems: 'flex-start', gap: space.xs },
  // in the column: full width by stretch, its height from the text (not a flex share)
  infoValueWrapStacked: { flex: 0 },
  infoIcon: { marginTop: 4 },
  infoValue: { ...typo.body, color: c.label, flex: 1 },
  infoNote: { ...typo.footnote, color: c.tertiaryLabel },
  note: { ...typo.footnote, color: c.secondaryLabel },
  more: { flexDirection: 'row', alignItems: 'center', gap: space.xxs, alignSelf: 'flex-start', minHeight: 28 },
  moreText: { ...typo.subheadline, fontWeight: weight.medium, color: c.accentText },
}));
