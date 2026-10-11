/**
 * One card on a dashboard or an app page (web parity: `TableCardFrame`): an
 * inset-grouped surface with an optional title row (and a trailing action),
 * and an error boundary — a card that throws shows "couldn't be shown" with an
 * "open on the web" note instead of taking the page down (an older build
 * meeting a newer spec, a malformed result).
 */

import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { t } from '../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';

export function CardFrame({
  title,
  action,
  children,
  style,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={[styles.card, style]}>
      {title || action ? (
        <View style={styles.head}>
          {title ? (
            <Text style={styles.title} numberOfLines={2} accessibilityRole="header">
              {title}
            </Text>
          ) : (
            <View style={{ flex: 1 }} />
          )}
          {action}
        </View>
      ) : null}
      <CardBoundary>{children}</CardBoundary>
    </View>
  );
}

/** A card's quiet message line (no access, unavailable, failed, nothing here). */
export function CardNote({
  icon = 'alertCircle',
  text,
  hint,
}: {
  icon?: 'alertCircle' | 'lock' | 'open' | 'table';
  text: string;
  hint?: string;
}) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.note} accessible>
      <Icon name={icon} size={16} color={c.tertiaryLabel} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={styles.noteText}>{text}</Text>
        {hint ? <Text style={styles.noteHint}>{hint}</Text> : null}
      </View>
    </View>
  );
}

/**
 * A card's error boundary: a renderer that throws shows "couldn't be shown"
 * (framed with `title` when given — a whole card failed — else just the note).
 */
export class CardBoundary extends React.Component<
  { children: React.ReactNode; title?: string; framed?: boolean },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    const note = <CardNote icon="open" text={t('apps.cardError')} hint={t('apps.cardWebOnlyHint')} />;
    return this.props.framed ? <CardFrame title={this.props.title}>{note}</CardFrame> : note;
  }
}

const useStyles = makeStyles((c) => ({
  card: {
    marginHorizontal: space.margin,
    marginBottom: space.lg,
    padding: space.md,
    gap: space.sm,
    backgroundColor: c.secondaryGroupedBackground,
    borderRadius: radius.xl,
    ...squircle,
    overflow: 'hidden',
  },
  head: { flexDirection: 'row', alignItems: 'center', gap: space.sm, minHeight: 28 },
  title: { ...typo.headline, fontWeight: weight.semibold, color: c.label, flex: 1 },
  note: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm, paddingVertical: space.xs },
  noteText: { ...typo.subheadline, color: c.secondaryLabel },
  noteHint: { ...typo.footnote, color: c.tertiaryLabel },
}));
