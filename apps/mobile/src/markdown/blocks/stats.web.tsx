/**
 * ```stats fenced block — headline figures as one flat grid inside the block's frame (web parity:
 * apps/web/src/components/blocks/business-blocks.tsx StatsBlock): hairline dividers, no tile per
 * figure. Columns adapt to the count (`statsColumns`) and the last row's cells share it, so three
 * figures sit on one row instead of 2 + 1. Direction (`trend`, the arrow) and colour (`tone`) are
 * separate: a rising cost is bad news, so colour appears only when the model said what it means.
 */
import { useMemo } from 'react';
import { StatsBlock as PhoneStats } from './stats.native';
import { StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { StatItem, StatsData } from '../../shared/rich-output';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../theme';
import { Icon } from '../../ui/core';
import { richSegment } from '../rich';
import { BlockActions } from './block-actions';
import { CodeBlock } from './code';

export function StatsBlock({ raw }: { raw: string }) {
  const { width } = useWindowDimensions();
  const seg = useMemo(() => richSegment('stats', raw), [raw]);
  if (width < 760) return <PhoneStats raw={raw} />;
  if (seg?.type !== 'stats') return <CodeBlock lang="stats" code={raw} />;
  return <Stats data={seg.data} />;
}

/** Same rule as the web KPI: thousands grouped, small numbers as written. */
function formatValue(value: number | string): string {
  if (typeof value !== 'number') return value;
  return Math.abs(value) >= 1000 ? value.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(value);
}

/** Columns for `count` figures: 3 stays one row on a phone, wider screens take up to 4. */
export function statsColumns(count: number, wide: boolean): number {
  if (count <= 2) return Math.max(count, 1);
  if (count === 3) return 3;
  if (!wide) return 2;
  return count % 4 === 0 ? 4 : count % 3 === 0 ? 3 : 4;
}

function Stats({ data }: { data: StatsData }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const { width } = useWindowDimensions();
  const columns = statsColumns(data.items.length, width >= 600);
  const rows: StatItem[][] = [];
  for (let i = 0; i < data.items.length; i += columns) rows.push(data.items.slice(i, i + columns));
  return (
    <View style={styles.card}>
      {data.title ? <Text style={styles.title}>{data.title}</Text> : null}
      <View>
        {rows.map((row, r) => (
          <View key={r} style={[styles.row, r > 0 && styles.rowDivider]}>
            {row.map((item, i) => (
              <Tile key={i} item={item} divider={i > 0} compact={columns >= 3} />
            ))}
          </View>
        ))}
      </View>
      {data.actions?.length ? <BlockActions actions={data.actions} /> : null}
    </View>
  );
}

function Tile({ item, divider, compact }: { item: StatItem; divider: boolean; compact: boolean }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const toneColor = item.tone === 'positive' ? c.green : item.tone === 'negative' ? c.red : c.secondaryLabel;
  const delta = item.delta === undefined ? null : String(item.delta);
  const arrow = item.trend === 'up' ? 'up' : item.trend === 'down' ? 'arrowDown' : null;
  return (
    <View
      style={[styles.tile, divider && styles.tileDivider]}
      accessible
      accessibilityLabel={[item.label, formatValue(item.value), item.unit, delta, item.hint].filter(Boolean).join(' ')}
    >
      <Text style={styles.label} numberOfLines={1}>
        {item.label}
      </Text>
      <View style={styles.valueRow}>
        <Text style={[styles.value, compact && styles.valueCompact]} numberOfLines={1} adjustsFontSizeToFit>
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

    gap: space.sm,
    borderRadius: radius.lg,

    overflow: 'hidden',
    ...squircle,
  },
  title: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label, paddingHorizontal: space.md },
  row: { flexDirection: 'row', gap: space.sm },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: c.separator },
  tile: {
    flex: 1,
    minWidth: 0,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    backgroundColor: c.secondaryBackground,
    borderRadius: radius.lg,
    paddingHorizontal: space.md,
    paddingVertical: space.sm + 2,
    gap: space.xxs,
  },
  tileDivider: {},
  label: { ...typo.footnote, color: c.secondaryLabel },
  valueRow: { flexDirection: 'row', alignItems: 'baseline', gap: space.xs },
  value: { ...typo.title2, fontWeight: weight.semibold, color: c.label, fontVariant: ['tabular-nums'], flexShrink: 1 },
  valueCompact: { ...typo.title1, fontWeight: weight.semibold },
  unit: { ...typo.footnote, color: c.secondaryLabel, flexShrink: 0 },
  deltaRow: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  delta: { ...typo.caption1, fontWeight: weight.semibold, fontVariant: ['tabular-nums'] },
  hint: { ...typo.caption1, color: c.tertiaryLabel, flexShrink: 1 },
}));
