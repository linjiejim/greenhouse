/**
 * ```chart fenced block — bar / line / pie / doughnut / radar rendered with
 * react-native-svg. Validated by the vendored shared parser (src/shared/
 * rich-output.ts) exactly like the web: the same loose LLM shapes are accepted
 * and the same payloads fall back to a plain code block.
 *
 * SVG paints need real color strings, so grid lines / labels use the `hex`
 * mirror of the system colors (never the PlatformColor `colors` objects);
 * series colors are data colors (the shared web palette). Nothing is painted
 * in a "background" color (the doughnut is a true ring), so charts sit right
 * on any surface — grouped cards, glass sheets.
 */
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, G, Line as SvgLine, Path, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { t } from '../../../lib/i18n';
import { makeStyles, radius, space, squircle, typo, useTheme, weight } from '../../../theme';
import { CodeBlock } from './code';
import { richSegment } from '../rich';
import type { ChartData, ChartType } from '../../../shared/rich-output';
import { HScroll } from './hscroll';

// Series palette — mirrors the web ChartBlock order so a chart looks the same
// across web / desktop / mobile.
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

/** Bar (grouped when multi-series) / line (one polyline per series). */
function CartesianChart({ spec }: { spec: ChartSpec }) {
  const { colors: c, hex } = useTheme();
  const styles = useStyles(c);
  const { type, labels, series } = spec;
  const isLine = type === 'line';
  const plotH = 140;
  const slot = Math.max(52, isLine ? 52 : series.length * 16 + 22);
  const W = Math.max(264, labels.length * slot);
  const max = Math.max(0, ...series.flatMap((s) => s.data));
  const y = (v: number) => (max <= 0 ? plotH : plotH - (Math.max(0, v) / max) * plotH);

  return (
    <>
      <HScroll>
        <View>
          <Svg width={W} height={plotH + 4}>
            <SvgLine x1={0} y1={plotH} x2={W} y2={plotH} stroke={hex.separator} strokeWidth={1} />
            {isLine
              ? series.map((s, si) => {
                  const color = SERIES_COLORS[si % SERIES_COLORS.length];
                  return (
                    <G key={si}>
                      <Polyline
                        points={s.data.map((v, k) => `${k * slot + slot / 2},${y(v)}`).join(' ')}
                        fill="none"
                        stroke={color}
                        strokeWidth={2}
                      />
                      {s.data.map((v, k) => (
                        <Circle key={k} cx={k * slot + slot / 2} cy={y(v)} r={3.5} fill={color} />
                      ))}
                    </G>
                  );
                })
              : labels.map((_, k) => {
                  const groupW = slot - 14;
                  const bandW = groupW / series.length;
                  const barW = Math.max(5, bandW - 3);
                  return series.map((s, si) => {
                    const v = s.data[k] ?? 0;
                    const x = k * slot + (slot - groupW) / 2 + si * bandW + (bandW - barW) / 2;
                    return (
                      <Rect
                        key={`${k}-${si}`}
                        x={x}
                        y={y(v)}
                        width={barW}
                        height={Math.max(0, plotH - y(v))}
                        rx={3}
                        fill={SERIES_COLORS[si % SERIES_COLORS.length]}
                      />
                    );
                  });
                })}
          </Svg>
          <View style={{ flexDirection: 'row', width: W }}>
            {labels.map((d, k) => (
              <Text key={k} numberOfLines={1} style={[styles.chartLabel, { width: slot }]}>
                {d}
              </Text>
            ))}
          </View>
        </View>
      </HScroll>
      {series.length > 1 ? (
        <Legend items={series.map((s, i) => ({ label: s.label, color: SERIES_COLORS[i % SERIES_COLORS.length] }))} />
      ) : null}
    </>
  );
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
  return (
    <View style={styles.chartWrap}>
      {parsed.title ? <Text style={styles.chartTitle}>{parsed.title}</Text> : null}
      {pie ? <PieChart spec={parsed} /> : radar ? <RadarChart spec={parsed} /> : <CartesianChart spec={parsed} />}
    </View>
  );
}

const useStyles = makeStyles((c) => ({
  chartWrap: {
    marginVertical: space.sm + 2,
    padding: space.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: c.separator,
    borderRadius: radius.md,
    ...squircle,
  },
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
