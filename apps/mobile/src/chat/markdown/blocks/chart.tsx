/**
 * ```chart fenced block — bar / line / pie / doughnut / radar rendered with
 * react-native-svg. Reads the same Chart.js spec the web/desktop renderer uses
 * ({ type, title, labels, datasets: [{ label, data }] }) plus loose LLM
 * fallbacks; falls back to a plain code block when the spec carries no numbers.
 */
import { Text, View } from 'react-native';
import { ScrollView } from 'react-native-gesture-handler';
import Svg, { Circle, G, Line as SvgLine, Path, Polygon, Polyline, Rect, Text as SvgText } from 'react-native-svg';
import { makeStyles, radius, useTheme } from '../../../theme';
import { CodeBlock } from './code';

const toNum = (v: any): number | null => {
  if (typeof v === 'number' && isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && isFinite(Number(v))) return Number(v);
  return null;
};

// Series palette — mirrors the web ChartBlock order so a chart looks the same
// across web / desktop / mobile.
const SERIES_COLORS = ['#6c995e', '#3f6f8a', '#c8881f', '#9b6bd6', '#c4503e', '#3aa0a0', '#d6792e', '#5b6b82'];

type ChartType = 'bar' | 'line' | 'pie' | 'doughnut' | 'radar';
interface ChartSpec {
  type: ChartType;
  title?: string;
  labels: string[];
  series: { label: string; data: number[] }[];
}

/** Normalise the chart JSON shapes an LLM emits into a uniform multi-series spec.
 *  Primary form is the canonical Chart.js spec the agent is told to use and that
 *  the web/desktop renderer consumes:
 *    { type, title, labels: [...], datasets: [{ label, data: [...] }] }
 *  with loose fallbacks kept for robustness:
 *    - data: [{ label|name|x, value|y|count }]
 *    - labels|categories + values|series|data parallel arrays */
function parseChart(cfg: any): ChartSpec | null {
  if (!cfg || typeof cfg !== 'object') return null;
  const type: ChartType = ['bar', 'line', 'pie', 'doughnut', 'radar'].includes(cfg.type) ? cfg.type : 'bar';
  let labels: string[] = Array.isArray(cfg.labels)
    ? cfg.labels.map(String)
    : Array.isArray(cfg.categories)
      ? cfg.categories.map(String)
      : [];
  let series: { label: string; data: number[] }[] = [];

  // canonical: datasets: [{ label, data: number[] }]
  if (Array.isArray(cfg.datasets)) {
    series = cfg.datasets
      .map((ds: any, i: number) => ({
        label: String(ds?.label ?? `系列 ${i + 1}`),
        data: (Array.isArray(ds?.data) ? ds.data : []).map((v: any) => toNum(v) ?? 0),
      }))
      .filter((s: { data: number[] }) => s.data.length > 0);
  }

  // loose: data: [{ label|name|x, value|y|count }]
  if (!series.length && Array.isArray(cfg.data) && cfg.data.some((d: any) => d && typeof d === 'object')) {
    const pts = cfg.data
      .map((d: any) => ({ label: String(d?.label ?? d?.name ?? d?.x ?? ''), value: toNum(d?.value ?? d?.y ?? d?.count) }))
      .filter((p: { value: number | null }) => p.value != null);
    if (!labels.length) labels = pts.map((p: { label: string }) => p.label);
    if (pts.length) series = [{ label: String(cfg.title ?? '系列'), data: pts.map((p: { value: number }) => p.value) }];
  }

  // loose: parallel labels + values/series/data arrays
  if (!series.length) {
    const vals: any[] = Array.isArray(cfg.values)
      ? cfg.values
      : Array.isArray(cfg.series)
        ? cfg.series
        : Array.isArray(cfg.data)
          ? cfg.data
          : [];
    const nums = vals
      .map((v) => toNum(v && typeof v === 'object' ? v.value ?? v.y : v))
      .filter((v): v is number => v != null);
    if (nums.length) series = [{ label: String(cfg.title ?? '系列'), data: nums }];
  }

  if (!series.length) return null;
  const n = Math.max(...series.map((s) => s.data.length));
  if (labels.length < n) labels = Array.from({ length: n }, (_, k) => labels[k] ?? String(k + 1));
  return { type, title: cfg.title ? String(cfg.title) : undefined, labels, series };
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
  const { colors: c } = useTheme();
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
      <ScrollView horizontal nestedScrollEnabled showsHorizontalScrollIndicator={false}>
        <View>
          <Svg width={W} height={plotH + 4}>
            <SvgLine x1={0} y1={plotH} x2={W} y2={plotH} stroke={c.hairline} strokeWidth={1} />
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
      </ScrollView>
      {series.length > 1 ? (
        <Legend items={series.map((s, i) => ({ label: s.label, color: SERIES_COLORS[i % SERIES_COLORS.length] }))} />
      ) : null}
    </>
  );
}

/** Pie / doughnut from the first series. */
function PieChart({ spec }: { spec: ChartSpec }) {
  const { colors: c } = useTheme();
  const vals = (spec.series[0]?.data ?? []).map((v) => Math.max(0, v));
  const total = vals.reduce((a, b) => a + b, 0);
  const size = 172;
  const r = size / 2;
  const cx = r;
  const cy = r;
  let angle = -Math.PI / 2;
  const arcs = vals.map((v, i) => {
    const frac = total > 0 ? v / total : 0;
    const start = angle;
    const end = angle + frac * Math.PI * 2;
    angle = end;
    const large = end - start > Math.PI ? 1 : 0;
    const x1 = cx + r * Math.cos(start);
    const y1 = cy + r * Math.sin(start);
    const x2 = cx + r * Math.cos(end);
    const y2 = cy + r * Math.sin(end);
    // A full-circle slice can't be drawn with a single arc (start == end), so
    // special-case it as two half-circles.
    const d =
      frac >= 0.999
        ? `M${cx},${cy - r} A${r},${r} 0 1 1 ${cx},${cy + r} A${r},${r} 0 1 1 ${cx},${cy - r} Z`
        : `M${cx},${cy} L${x1},${y1} A${r},${r} 0 ${large} 1 ${x2},${y2} Z`;
    return { d, color: SERIES_COLORS[i % SERIES_COLORS.length] };
  });
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={size} height={size}>
        {arcs.map((a, i) => (
          <Path key={i} d={a.d} fill={a.color} />
        ))}
        {spec.type === 'doughnut' ? <Circle cx={cx} cy={cy} r={r * 0.56} fill={c.surface} /> : null}
      </Svg>
      <Legend
        items={spec.labels.map((l, i) => ({
          label: total > 0 ? `${l} · ${Math.round((vals[i] ?? 0) / total * 100)}%` : l,
          color: SERIES_COLORS[i % SERIES_COLORS.length],
        }))}
      />
    </View>
  );
}

/** Radar — one filled polygon per series over a ringed grid. */
function RadarChart({ spec }: { spec: ChartSpec }) {
  const { colors: c } = useTheme();
  const { labels, series } = spec;
  const n = labels.length;
  const size = 220;
  const cx = size / 2;
  const cy = size / 2;
  const R = size / 2 - 30;
  const max = Math.max(0, ...series.flatMap((s) => s.data));
  const angleAt = (i: number) => -Math.PI / 2 + (i / n) * Math.PI * 2;
  const pt = (i: number, radiusAt: number) => `${cx + radiusAt * Math.cos(angleAt(i))},${cy + radiusAt * Math.sin(angleAt(i))}`;
  return (
    <View style={{ alignItems: 'center' }}>
      <Svg width={size} height={size}>
        {[0.25, 0.5, 0.75, 1].map((f, ri) => (
          <Polygon key={ri} points={labels.map((_, i) => pt(i, R * f)).join(' ')} fill="none" stroke={c.hairline} strokeWidth={1} />
        ))}
        {labels.map((_, i) => (
          <SvgLine key={i} x1={cx} y1={cy} x2={cx + R * Math.cos(angleAt(i))} y2={cy + R * Math.sin(angleAt(i))} stroke={c.hairline} strokeWidth={1} />
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
            <SvgText key={i} x={lx} y={ly} fontSize={10} fill={c.fgMuted} textAnchor={anchor} alignmentBaseline="middle">
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
  let cfg: any;
  try {
    cfg = JSON.parse(spec);
  } catch {
    cfg = null;
  }
  const parsed = parseChart(cfg);
  if (!parsed) return <CodeBlock lang="chart" code={spec} />;
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
    marginVertical: 12,
    padding: 12,
    borderWidth: 1,
    borderColor: c.hairline,
    borderRadius: radius.md,
    backgroundColor: c.surface,
  },
  chartTitle: { fontSize: 13, fontWeight: '700', color: c.fg, marginBottom: 10 },
  chartLabel: { fontSize: 11, color: c.fgMuted, textAlign: 'center', paddingHorizontal: 2, marginTop: 6 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 12, justifyContent: 'center' },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 5, maxWidth: 150 },
  legendDot: { width: 9, height: 9, borderRadius: 3 },
  legendText: { fontSize: 11.5, color: c.fgSecondary, flexShrink: 1 },
}));
