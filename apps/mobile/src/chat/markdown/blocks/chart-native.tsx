import { Host } from '@expo/ui/swift-ui';
import { NativeChartView, nativeChartSupports } from '../../../../modules/native-chart';
import { useTheme, space } from '../../../theme';
import { useLocaleEnv } from '../../../ui/native-form';
import { t } from '../../../lib/i18n';
import type { ChartSpec } from './chart';
import { CHART_COLORS as SERIES_COLORS, PLOT_H } from './chart-scale';
export { nativeChartSupports };
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
export function SwiftChart({ spec }: { spec: ChartSpec }) {
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
