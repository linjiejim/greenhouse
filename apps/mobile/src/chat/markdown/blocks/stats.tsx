/**
 * ```stats fenced block — headline figures as two-up tiles (web parity:
 * @greenhouse/ui StatsBlock). Direction (`trend`, the arrow) and colour
 * (`tone`) are separate: a rising cost is bad news, so colour appears only when
 * the model said what the change means.
 */
import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { StatItem, StatsData } from '../../../shared/rich-output';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { Icon } from '../../../ui/core';
import { richSegment } from '../rich';
import { BlockActions } from './block-actions';
import { CodeBlock } from './code';

export function StatsBlock({ raw }: { raw: string }) {
  const seg = useMemo(() => richSegment('stats', raw), [raw]);
  if (seg?.type !== 'stats') return <CodeBlock lang="stats" code={raw} />;
  return <Stats data={seg.data} />;
}

/** Same rule as the web KPI: thousands grouped, small numbers as written. */
function formatValue(value: number | string): string {
  if (typeof value !== 'number') return value;
  return Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(value);
}

function Stats({ data }: { data: StatsData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.card}>
      {data.title ? <Text style={styles.title}>{data.title}</Text> : null}
      <View style={styles.grid}>
        {data.items.map((item, i) => (
          <Tile key={i} item={item} />
        ))}
      </View>
      {data.actions?.length ? <BlockActions actions={data.actions} /> : null}
    </View>
  );
}

function Tile({ item }: { item: StatItem }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const toneColor = item.tone === 'positive' ? c.green : item.tone === 'negative' ? c.red : c.secondaryLabel;
  const delta = item.delta === undefined ? null : String(item.delta);
  const arrow = item.trend === 'up' ? 'up' : item.trend === 'down' ? 'arrowDown' : null;
  return (
    <View
      style={styles.tile}
      accessible
      accessibilityLabel={[item.label, formatValue(item.value), item.unit, delta, item.hint].filter(Boolean).join(' ')}
    >
      <Text style={styles.label} numberOfLines={1}>
        {item.label}
      </Text>
      <View style={styles.valueRow}>
        <Text style={styles.value} numberOfLines={1}>
          {formatValue(item.value)}
        </Text>
        {item.unit ? <Text style={styles.unit}>{item.unit}</Text> : null}
      </View>
      {delta || item.hint ? (
        <View style={styles.deltaRow}>
          {arrow ? <Icon name={arrow} size={11} weight="semibold" color={toneColor} /> : null}
          {delta ? <Text style={[styles.delta, { color: toneColor }]}>{delta}</Text> : null}
          {item.hint ? (
            <Text style={styles.hint} numberOfLines={1}>
              {item.hint}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  card: {
    marginVertical: space.sm + 2,
    padding: space.md,
    gap: space.md,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    ...squircle,
  },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    borderRadius: radius.md,
    backgroundColor: c.tertiaryFill,
    gap: space.xxs,
    ...squircle,
  },
  label: { ...typo.footnote, color: c.secondaryLabel },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.xs },
  value: { ...typo.title2, fontWeight: weight.semibold, color: c.label, fontVariant: ['tabular-nums'], flexShrink: 1 },
  unit: { ...typo.footnote, color: c.secondaryLabel, flexShrink: 0 },
  deltaRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  delta: { ...typo.caption1, fontWeight: weight.semibold, fontVariant: ['tabular-nums'] },
  hint: { ...typo.caption1, color: c.tertiaryLabel, flexShrink: 1 },
}));
