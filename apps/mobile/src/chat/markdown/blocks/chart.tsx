/**
 * ```chart fenced block — bar / line / pie / doughnut / radar. Validated by the
 * vendored shared parser (src/shared/rich-output.ts) exactly like the web: the
 * same loose LLM shapes are accepted and the same payloads fall back to a
 * plain code block.
 *
 * On iOS the chart is native — Swift Charts (modules/native-chart: system
 * axes, legend, VoiceOver audio graphs, tap a label for its values; pie and
 * doughnut from iOS 17). The radar (Swift Charts has none), Android and
 * binaries built before the module draw it with react-native-svg below.
 *
 * SVG paints need real color strings, so grid lines / labels use the `hex`
 * mirror of the system colors (never the PlatformColor `colors` objects);
 * series colors are data colors (the shared web palette). Nothing is painted
 * in a "background" color (the doughnut is a true ring), so charts sit right
 * on any surface — grouped cards, glass sheets.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Svg, { Circle, G, Line as SvgLine, Path, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { t } from '../../../lib/i18n';
import { makeStyles, space, typo, useTheme, weight } from '../../../theme';
import { ChatCard } from '../../chat-card';
import { CodeBlock } from './code';
import { richSegment } from '../rich';
import type { ChartData, ChartType } from '../../../shared/rich-output';
import { formatTick, niceScale } from './chart-scale';
import { HScroll } from './hscroll';
import { Host } from '@expo/ui/swift-ui';
import { NativeChartView, nativeChartSupports } from '../../../../modules/native-chart';
import { useLocaleEnv } from '../../../ui/native-form';

// Series palette: the Haven green first, then hues far enough apart to tell
// series apart on a phone (the web's greens-only palette blurs them at this
// size). Data colors — the same in light and dark.
const SERIES_COLORS = ['#6c995e', '#3f6f8a', '#c8881f', '#9b6bd6', '#c4503e', '#3aa0a0', '#d6792e', '#5b6b82'];

interface ChartSpec {
  type: ChartType;
  title?: string;
  labels: string[];
  series: { label: string; data: number[] }[];
}

/**
 * The validated chart (the shared parser already accepted the loose shapes
 * models write and rejected anything it cannot plot — the same verdict as the
 * web) as this renderer's series list. An unlabelled series gets a local name.
 */
function toSpec(data: ChartData): ChartSpec {
  return {
    type: data.type,
    title: data.title,
    labels: data.labels,
    series: data.datasets.map((dataset, i) => ({
      label: dataset.label || t('chat.series', { n: i + 1 }),
      data: dataset.data,
    })),
  };
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  return (
    <View style={styles.legend}>
      {items.map((it, i) => (
        <View key={i} style={styles.legendItem}>
          <View style={[styles.legendDot, { backgroundColor: it.color }]} />
          <Text numberOfLines={1} style={styles.legendText}>
            {it.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** Chart plot height (pt) and the room above it for the tallest bar's value. */
const PLOT_H = 168;
const TOP_PAD = 18;
/** Space between the value axis labels and the plot. */
const GUTTER_PAD = 6;

/**
 * Bar (grouped when multi-series) / line (one polyline per series), across the
 * card's whole width: slots share the measured width (2026-10: the plot was
 * `labels × 52 pt` wide whatever the card, so three bars filled half of it),
 * down to a floor per slot past which the plot scrolls sideways under a fixed
 * value axis. Round ticks with hairline gridlines and a zero baseline (bars
 * below zero grow down); a bar's value sits on it when there are few; tapping
 * a slot names it and its values under the plot.
 */
function CartesianChart({ spec }: { spec: ChartSpec }) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const { width: windowW } = useWindowDimensions();
  // first frame: the reply column (window − reply margins − card padding and border); then measured
  const [avail, setAvail] = useState(() => Math.max(200, windowW - space.margin * 2 - space.md * 2 - 2));
  const [selected, setSelected] = useState<number | null>(null);
  const { type, labels, series } = spec;
  const isLine = type === 'line';
  const scale = useMemo(() => niceScale(series.flatMap((s) => s.data)), [series]);
  const tickTexts = scale.ticks.map(formatTick);
  const gutter = Math.ceil(Math.max(1, ...tickTexts.map((text) => text.length)) * 6.6) + GUTTER_PAD;
  const minSlot = isLine ? 36 : Math.max(30, series.length * 12 + 14);
  const slot = Math.max(minSlot, (avail - gutter) / Math.max(1, labels.length));
  const plotW = slot * labels.length;
  const span = scale.max - scale.min || 1;
  const yOf = (v: number) => PLOT_H - ((v - scale.min) / span) * PLOT_H;
  const zeroY = yOf(0);
  const showValues = !isLine && labels.length * series.length <= 8 && slot >= 34;
  const colorOf = (si: number) => SERIES_COLORS[si % SERIES_COLORS.length];

  const bars = !isLine
    ? labels.flatMap((_, k) => {
        const groupW = Math.min(slot - 12, series.length * 34);
        const bandW = groupW / series.length;
        const barW = Math.max(5, bandW - 4);
        return series.map((s, si) => {
          const v = s.data[k] ?? 0;
          const x = k * slot + (slot - groupW) / 2 + si * bandW + (bandW - barW) / 2;
          const top = Math.min(yOf(v), zeroY);
          return { k, si, v, x, w: barW, top, h: Math.max(v === 0 ? 0 : 1, Math.abs(zeroY - yOf(v))) };
        });
      })
    : [];

  const detail =
    selected === null
      ? null
      : [
          labels[selected],
          series
            .map((s) => `${series.length > 1 ? `${s.label} ` : ''}${formatValue(s.data[selected])}`)
            .join(' · '),
        ].join('  ');

  return (
    <View onLayout={(e) => setAvail(Math.floor(e.nativeEvent.layout.width))}>
      <View style={styles.cartesian}>
        {/* the value axis stays put while a wide plot scrolls */}
        <View style={{ width: gutter, height: PLOT_H + TOP_PAD }}>
          {scale.ticks.map((tick, i) => (
            <Text
              key={i}
              numberOfLines={1}
              style={[styles.tick, { top: TOP_PAD + yOf(tick) - 7, right: GUTTER_PAD }]}
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
            >
              {tickTexts[i]}
            </Text>
          ))}
        </View>
        <HScroll>
          <View>
            <Svg width={plotW} height={PLOT_H + TOP_PAD}>
              <G y={TOP_PAD}>
                {selected !== null ? (
                  <Rect x={selected * slot + 2} y={0} width={slot - 4} height={PLOT_H} rx={6} fill={hex.fill} />
                ) : null}
                {scale.ticks.map((tick, i) => (
                  <SvgLine
                    key={i}
                    x1={0}
                    y1={yOf(tick)}
                    x2={plotW}
                    y2={yOf(tick)}
                    stroke={hex.separator}
                    strokeWidth={tick === 0 ? 1 : 0.5}
                    strokeDasharray={tick === 0 ? undefined : '3 4'}
                  />
                ))}
                {isLine
                  ? series.map((s, si) => (
                      <G key={si}>
                        <Polyline
                          points={s.data.map((v, k) => `${k * slot + slot / 2},${yOf(v)}`).join(' ')}
                          fill="none"
                          stroke={colorOf(si)}
                          strokeWidth={2.5}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                        {s.data.map((v, k) => (
                          <Circle
                            key={k}
                            cx={k * slot + slot / 2}
                            cy={yOf(v)}
                            r={selected === k ? 5 : 3.5}
                            fill={colorOf(si)}
                          />
                        ))}
                      </G>
                    ))
                  : bars.map((bar) => (
                      <G key={`${bar.k}-${bar.si}`}>
                        <Rect
                          x={bar.x}
                          y={bar.top}
                          width={bar.w}
                          height={bar.h}
                          rx={Math.min(4, bar.w / 3)}
                          fill={colorOf(bar.si)}
                        />
                        {showValues ? (
                          <SvgText
                            x={bar.x + bar.w / 2}
                            y={bar.v >= 0 ? bar.top - 5 : bar.top + bar.h + 12}
                            fontSize={11}
                            fill={hex.secondaryLabel}
                            textAnchor="middle"
                          >
                            {formatValue(bar.v)}
                          </SvgText>
                        ) : null}
                      </G>
                    ))}
              </G>
            </Svg>
            {/* one tap target per slot: name it and its values (again to clear) */}
            <View style={[StyleSheet.absoluteFill, styles.slots]}>
              {labels.map((label, k) => (
                <Pressable
                  key={k}
                  style={{ width: slot }}
                  onPress={() => setSelected((current) => (current === k ? null : k))}
                  accessibilityRole="button"
                  accessibilityLabel={`${label}: ${series.map((s) => `${s.label} ${formatValue(s.data[k])}`).join(', ')}`}
                />
              ))}
            </View>
            <View style={{ flexDirection: 'row', width: plotW }}>
              {labels.map((d, k) => (
                <Text
                  key={k}
                  numberOfLines={1}
                  style={[styles.chartLabel, { width: slot }, selected === k && styles.chartLabelOn]}
                >
                  {d}
                </Text>
              ))}
            </View>
          </View>
        </HScroll>
      </View>
      {detail ? (
        <Text style={styles.detail} numberOfLines={2}>
          {detail}
        </Text>
      ) : series.length > 1 ? (
        <Legend items={series.map((s, i) => ({ label: s.label, color: colorOf(i) }))} />
      ) : null}
    </View>
  );
}

/** A value as the chart shows it: up to two decimals, grouped thousands. */
function formatValue(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '–';
  return Number(value.toFixed(2)).toLocaleString();
}

/**
 * Pie / doughnut from the first series. Slices are sector paths; doughnut
 * slices are annulus paths (outer arc → inner arc back), never a pie with a
 * background-colored disc painted over it.
 */
function PieChart({ spec }: { spec: ChartSpec }) {
  const vals = (spec.series[0]?.data ?? []).map((v) => Math.max(0, v));
  const total = vals.reduce((a, b) => a + b, 0);
  const size = 172;
  const r = size / 2;
  const ri = spec.type === 'doughnut' ? r * 0.56 : 0;
  const cx = r;
  const cy = r;
  const pt = (rad: number, a: number) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
  let angle = -Math.PI / 2;
  const arcs = vals.map((v, i) => {
    const frac = total > 0 ? v / total : 0;
    const start = angle;
    const end = angle + frac * Math.PI * 2;
    angle = end;
    const large = end - start > Math.PI ? 1 : 0;
    let d: string;
    if (frac >= 0.999) {
      // A full ring can't be one arc (start == end): two half circles each way.
      d = `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx},${cy + r} A${r},${r} 0 1 1 ${cx},${cy - r} Z`;
      if (ri) d += ` M${cx},${cy - ri} A${ri},${ri} 0 1 0 ${cx},${cy + ri} A${ri},${ri} 0 1 0 ${cx},${cy - ri} Z`;
    } else if (ri) {
      d = `M${pt(r, start)} A${r},${r} 0 ${large} 1 ${pt(r, end)} L${pt(ri, end)} A${ri},${ri} 0 ${large} 0 ${pt(ri, start)} Z`;
    } else {
      d = `M${cx},${cy} L${pt(r, start)} A${r},${r} 0 ${large} 1 ${pt(r, end)} Z`;
    }
    return { d, color: SERIES_COLORS[i % SERIES_COLORS.length] };
  });
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={size} height={size}>
        {arcs.map((a, i) => (
          <Path key={i} d={a.d} fill={a.color} fillRule="evenodd" />
        ))}
      </Svg>
      <Legend
        items={spec.labels.map((l, i) => ({
          label: total > 0 ? `${l} · ${Math.round(((vals[i] ?? 0) / total) * 100)}%` : l,
          color: SERIES_COLORS[i % SERIES_COLORS.length],
        }))}
      />
    </View>
  );
}

/** Radar — one filled polygon per series over a ringed grid. */
function RadarChart({ spec }: { spec: ChartSpec }) {
  const { hex } = useTheme();
  const { labels, series } = spec;
  const n = labels.length;
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 30;
  const max = Math.max(0, ...series.flatMap((s) => s.data));
  const angleAt = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pt = (i: number, radiusAt: number) =>
    `${cx + radiusAt * Math.cos(angleAt(i))},${cy + radiusAt * Math.sin(angleAt(i))}`;
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={size} height={size}>
        {[0.25, 0.5, 0.75, 1].map((f, ri) => (
          <Polygon
            key={ri}
            points={labels.map((_, i) => pt(i, R * f)).join(' ')}
            fill="none"
            stroke={hex.separator}
            strokeWidth={1}
          />
        ))}
        {labels.map((_, i) => (
          <SvgLine
            key={i}
            x1={cx}
            y1={cy}
            x2={cx + R * Math.cos(angleAt(i))}
            y2={cy + R * Math.sin(angleAt(i))}
            stroke={hex.separator}
            strokeWidth={1}
          />
        ))}
        {series.map((s, si) => {
          const color = SERIES_COLORS[si % SERIES_COLORS.length];
          const points = labels.map((_, i) => pt(i, max > 0 ? (Math.max(0, s.data[i] ?? 0) / max) * R : 0)).join(' ');
          return <Polygon key={si} points={points} fill={color} fillOpacity={0.18} stroke={color} strokeWidth={2} />;
        })}
        {labels.map((l, i) => {
          const a = angleAt(i);
          const lx = cx + (R + 14) * Math.cos(a);
          const ly = cy + (R + 14) * Math.sin(a);
          const anchor = Math.abs(Math.cos(a)) < 0.3 ? 'middle' : Math.cos(a) > 0 ? 'start' : 'end';
          return (
            <SvgText
              key={i}
              x={lx}
              y={ly}
              fontSize={10}
              fill={hex.secondaryLabel}
              textAnchor={anchor}
              alignmentBaseline="middle"
            >
              {l.length > 6 ? l.slice(0, 6) + '…' : l}
            </SvgText>
          );
        })}
      </Svg>
      {series.length > 1 ? (
        <Legend items={series.map((s, i) => ({ label: s.label, color: SERIES_COLORS[i % SERIES_COLORS.length] }))} />
      ) : null}
    </View>
  );
}

export function Chart({ spec }: { spec: string }) {
  const { colors: c } = useTheme();
  const styles = useStyles(c);
  const segment = richSegment('chart', spec);
  if (segment?.type !== 'chart') return <CodeBlock lang="chart" code={spec} />;
  const parsed = toSpec(segment.data);
  // A radar needs ≥3 axes to read as a polygon; degenerate cases fall back to bars.
  const radar = parsed.type === 'radar' && parsed.labels.length >= 3;
  const pie = parsed.type === 'pie' || parsed.type === 'doughnut';
  const native = !radar && nativeChartSupports(parsed.type === 'radar' ? 'bar' : parsed.type);
  return (
    <ChatCard style={styles.chartWrap}>
      {parsed.title ? <Text style={styles.chartTitle}>{parsed.title}</Text> : null}
      {native ? (
        <SwiftChart spec={parsed} />
      ) : pie ? (
        <PieChart spec={parsed} />
      ) : radar ? (
        <RadarChart spec={parsed} />
      ) : (
        <CartesianChart spec={parsed} />
      )}
    </ChatCard>
  );
}

/** Repeated names made distinct with zero-width spaces (they key Swift Charts' colors and categories). */
function distinct(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((name) => {
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return n ? `${name}${'\u200b'.repeat(n)}` : name;
  });
}

/** Room for the plot, the legend rows and the line under it. */
function nativeHeight(spec: ChartSpec): number {
  if (spec.type === 'pie' || spec.type === 'doughnut') return 220 + Math.ceil(spec.labels.length / 3) * 20;
  return PLOT_H + 48 + (spec.series.length > 1 ? Math.ceil(spec.series.length / 3) * 20 : 0);
}

/** The chart as Swift Charts draws it (modules/native-chart), in a SwiftUI host with the app's scheme and locale. */
function SwiftChart({ spec }: { spec: ChartSpec }) {
  const { isDark } = useTheme();
  const locale = useLocaleEnv();
  const labels = distinct(spec.labels);
  const names = distinct(spec.series.map((s) => s.label));
  const pie = spec.type === 'pie' || spec.type === 'doughnut';
  const type = spec.type === 'radar' ? 'bar' : spec.type;
  return (
    <Host
      style={{ height: nativeHeight(spec), marginTop: space.xs }}
      ignoreSafeArea="all"
      colorScheme={isDark ? 'dark' : 'light'}
      modifiers={[locale]}
    >
      <NativeChartView
        type={type}
        labels={labels}
        series={spec.series.map((s, i) => ({
          label: names[i],
          data: s.data,
          color: SERIES_COLORS[i % SERIES_COLORS.length],
        }))}
        sliceColors={pie ? labels.map((_, i) => SERIES_COLORS[i % SERIES_COLORS.length]) : undefined}
        valueLabels={type === 'bar' && labels.length * spec.series.length <= 8}
        hint={pie ? undefined : t('chat.chartTapHint')}
      />
    </Host>
  );
}

const useStyles = makeStyles((c) => ({
  chartWrap: { marginVertical: space.sm + 2, padding: space.md },
  cartesian: { flexDirection: 'row' },
  tick: { position: 'absolute', ...typo.caption2, color: c.tertiaryLabel, fontVariant: ['tabular-nums'] },
  slots: { flexDirection: 'row' },
  chartLabelOn: { color: c.label, fontWeight: weight.semibold },
  detail: { ...typo.footnote, color: c.label, textAlign: 'center', marginTop: space.md },
  chartTitle: { ...typo.subheadline, fontWeight: weight.semibold, color: c.label, marginBottom: space.sm + 2 },
  chartLabel: {
    ...typo.caption1,
    color: c.secondaryLabel,
    textAlign: 'center',
    paddingHorizontal: 2,
    marginTop: space.xs + 2,
  },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm + 2, marginTop: space.md, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs + 1, maxWidth: 150 },
  legendDot: { width: 9, height: 9, borderRadius: 3 },
  legendText: { ...typo.caption1, color: c.secondaryLabel, flexShrink: 1 },
}));
