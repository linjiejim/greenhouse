/**
 * ```cards fenced block — records worth scanning (projects, customers,
 * documents…) as a stack of compact cards (web parity: @greenhouse/ui
 * CardsBlock). A card with a link opens it the way a tapped markdown link
 * would: a record peek sheet, the in-app Safari view, or "open on the web".
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { CardBadgeTone, CardItem, CardsData } from '../../../shared/rich-output';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { Icon, Touchable } from '../../../ui/core';
import { Badge, type BadgeTone } from '../../../ui/list';
import { useOpenLink } from '../inline';
import { richSegment } from '../rich';
import { BlockActions } from './block-actions';
import { CodeBlock } from './code';

const BADGE_TONE: Record<CardBadgeTone, BadgeTone> = {
  neutral: 'neutral',
  primary: 'accent',
  success: 'green',
  warning: 'orange',
  danger: 'red',
  info: 'blue',
};

export function CardsBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('cards', raw), [raw]);
  if (seg?.type !== 'cards') return <CodeBlock lang="cards" code={raw} />;
  return <Cards data={seg.data} />;
}

function Cards({ data }: { data: CardsData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.wrap}>
      {data.title ? <Text style={styles.title}>{data.title}</Text> : null}
      {data.items.map((item, i) => (
        <Card key={i} item={item} />
      ))}
      {data.actions?.length ? <BlockActions actions={data.actions} /> : null}
    </View>
  );
}

function Card({ item }: { item: CardItem }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const open = useOpenLink();
  const external = Boolean(item.url && /^https?:/i.test(item.url));
  const body = (
    <>
      <View style={styles.head}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </Text>
        {item.url ? <Icon name={external ? 'open' : 'chevR'} size={13} color={c.tertiaryLabel} /> : null}
      </View>
      {item.subtitle ? (
        <Text style={styles.subtitle} numberOfLines={2}>
          {item.subtitle}
        </Text>
      ) : null}
      {item.badges?.length ? (
        <View style={styles.badges}>
          {item.badges.map((badge, i) => (
            <Badge key={i} label={badge.label} tone={BADGE_TONE[badge.tone ?? 'neutral']} />
          ))}
        </View>
      ) : null}
      {item.fields?.length ? (
        <View style={styles.fields}>
          {item.fields.map((field, i) => (
            <Text key={i} style={styles.field} numberOfLines={1}>
              <Text style={styles.fieldLabel}>{field.label} </Text>
              {field.value}
            </Text>
          ))}
        </View>
      ) : null}
    </>
  );
  if (!item.url) return <View style={styles.card}>{body}</View>;
  return (
    <Touchable
      style={styles.card}
      onPress={() => open(item.url!, item.title)}
      accessibilityRole="link"
      accessibilityLabel={item.title}
    >
      {body}
    </Touchable>
  );
}

const useStyles = makeStyles((c) => ({
  wrap: { marginVertical: space.sm + 2, gap: space.sm },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  card: {
    padding: space.md,
    gap: space.xs + 2,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...squircle,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: space.sm },
  cardTitle: { ...typo.callout, fontWeight: weight.semibold, color: c.label, flex: 1 },
  subtitle: { ...typo.footnote, color: c.secondaryLabel },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  fields: { flexDirection: 'row', flexWrap: 'wrap', columnGap: space.md, rowGap: space.xxs },
  field: { ...typo.footnote, color: c.label },
  fieldLabel: { color: c.tertiaryLabel },
}));
