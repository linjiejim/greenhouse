/**
 * Chart.js configuration for `<ChartBlock>` — pure, so the mark specs, the
 * display options and the click mapping are testable without a canvas.
 *
 * Colours come from the categorical tokens `--t-chart-1..8` (tokens.css, both
 * modes), read at render time: Chart.js draws on a canvas and needs literal
 * colour strings, and a theme switch rebuilds the config. Slots are assigned in
 * fixed order and never generated — callers that know an entity's stable
 * position (a select option, a series key) pass it as `colorSlots`, so a filter
 * that removes a series does not repaint the others.
 */

import type { ChartData } from './index';

/** How a chart is drawn — kept apart from `ChartData`, which is the model-authored rich-block protocol. */
export interface ChartDisplayOptions {
  /** Bars / areas of one label stack instead of standing side by side (needs ≥ 2 datasets). */
  stacked?: boolean;
  /** Bars run left to right (category axis vertical). Bar charts only. */
  horizontal?: boolean;
  /** Line charts fill down to the axis. */
  area?: boolean;
  /** Print each value on its mark. */
  showValues?: boolean;
  /** 0-based palette slot per dataset (cartesian) or per point (pie / doughnut). Default: position. */
  colorSlots?: readonly number[];
  /** Marks are clickable: pointer cursor on hover. */
  interactive?: boolean;
}

/** A clicked mark: which dataset and which label (point) it belongs to. */
export interface ChartPointRef {
  datasetIndex: number;
  index: number;
}

export interface ChartTheme {
  text: string;
  textMuted: string;
  edge: string;
  surface: string;
  palette: readonly string[];
}

export const CHART_SLOT_COUNT = 8;

/** Light-mode values of `--t-chart-1..8` — only used where no stylesheet is present (SSR, tests). */
const FALLBACK_PALETTE = ['#2b8a5e', '#2a78d6', '#eb6834', '#4a3aa7', '#e87ba4', '#eda100', '#0f93b0', '#a0612e'];

function readThemeColor(variable: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
}

/** The active appearance's chart colours. Call again after a theme change. */
export function readChartTheme(): ChartTheme {
  return {
    text: readThemeColor('--t-fg-secondary', '#455147'),
    textMuted: readThemeColor('--t-fg-muted', '#5f6a61'),
    edge: readThemeColor('--t-edge', '#e6ece3'),
    surface: readThemeColor('--t-surface-card', '#f7faf5'),
    palette: FALLBACK_PALETTE.map((fallback, index) => readThemeColor(`--t-chart-${index + 1}`, fallback)),
  };
}

/** `#rgb` / `#rrggbb` / `rgb(r, g, b)` with an alpha channel; anything else is returned as is. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const digits = hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit).join('') : hex[1]!;
    const value = parseInt(digits, 16);
    return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
  }
  const rgb = color.trim().match(/^rgb\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)\s*\)$/i);
  return rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${alpha})` : color;
}

function slotColor(theme: ChartTheme, slot: number | undefined, position: number): string {
  const index = slot ?? position;
  return theme.palette[((index % CHART_SLOT_COUNT) + CHART_SLOT_COUNT) % CHART_SLOT_COUNT] ?? FALLBACK_PALETTE[0]!;
}

const numberFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });

interface DrawableElement {
  x: number;
  y: number;
  base?: number;
  tooltipPosition: (useFinalPosition?: boolean) => { x: number; y: number };
}

interface ValueLabelChart {
  ctx: CanvasRenderingContext2D;
  data: { datasets: Array<{ data: unknown[] }> };
  getDatasetMeta: (index: number) => { hidden?: boolean | null; data: unknown[] };
  isDatasetVisible?: (index: number) => boolean;
}

/**
 * Inline Chart.js plugin printing each value on its mark: above a bar (beside it
 * when horizontal), in the middle of a stacked segment, at a slice's centroid.
 * Text wears the text token with a surface-coloured halo, never the series colour.
 */
function valueLabelsPlugin(
  theme: ChartTheme,
  fontFamily: string,
  mode: 'bar' | 'stacked' | 'horizontal' | 'radial' | 'point',
) {
  return {
    id: 'greenhouseValueLabels',
    afterDatasetsDraw(chart: ValueLabelChart) {
      const { ctx } = chart;
      ctx.save();
      ctx.font = `600 10px ${fontFamily}`;
      ctx.fillStyle = theme.text;
      ctx.strokeStyle = theme.surface;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        if (chart.isDatasetVisible && !chart.isDatasetVisible(datasetIndex)) return;
        const meta = chart.getDatasetMeta(datasetIndex);
        meta.data.forEach((raw, index) => {
          const value = dataset.data[index];
          if (typeof value !== 'number' || value === 0) return;
          const element = raw as DrawableElement;
          const text = numberFormat.format(value);
          let { x, y } = element.tooltipPosition(true);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (mode === 'bar' || mode === 'point') {
            y -= 8;
          } else if (mode === 'horizontal') {
            ctx.textAlign = 'left';
            x += 6;
          } else if (mode === 'stacked' && typeof element.base === 'number') {
            y = (element.y + element.base) / 2;
          }
          ctx.strokeText(text, x, y);
          ctx.fillText(text, x, y);
        });
      });
      ctx.restore();
    },
  };
}

/** The full Chart.js config for one chart. */
export function buildChartConfig(
  data: ChartData,
  display: ChartDisplayOptions,
  theme: ChartTheme,
  fontFamily: string,
): Record<string, unknown> {
  const isRadial = data.type === 'pie' || data.type === 'doughnut';
  const isBar = data.type === 'bar';
  const isLine = data.type === 'line';
  const stacked = Boolean(display.stacked) && !isRadial && data.datasets.length > 1;
  const horizontal = Boolean(display.horizontal) && isBar;

  const datasets = data.datasets.map((dataset, position) => {
    if (isRadial) {
      return {
        label: dataset.label,
        data: dataset.data,
        backgroundColor: dataset.data.map((_, point) => slotColor(theme, display.colorSlots?.[point], point)),
        // A surface-coloured ring separates adjacent slices.
        borderColor: theme.surface,
        borderWidth: 2,
      };
    }
    const color = slotColor(theme, display.colorSlots?.[position], position);
    if (isLine) {
      return {
        label: dataset.label,
        data: dataset.data,
        borderColor: color,
        backgroundColor: display.area ? withAlpha(color, stacked ? 0.55 : 0.18) : color,
        borderWidth: 2,
        tension: 0.3,
        fill: display.area ? (stacked && position > 0 ? '-1' : 'origin') : false,
        pointRadius: 4,
        pointHoverRadius: 6,
        pointBackgroundColor: color,
        pointBorderColor: theme.surface,
        pointBorderWidth: 2,
      };
    }
    if (data.type === 'radar') {
      return {
        label: dataset.label,
        data: dataset.data,
        borderColor: color,
        backgroundColor: withAlpha(color, 0.2),
        borderWidth: 2,
      };
    }
    return {
      label: dataset.label,
      data: dataset.data,
      backgroundColor: color,
      // Stacked segments are separated by a thin surface gap; free bars get
      // rounded data ends anchored to the baseline.
      borderColor: theme.surface,
      borderWidth: stacked ? 1 : 0,
      borderRadius: stacked ? 0 : 4,
      borderSkipped: 'start',
      maxBarThickness: 48,
    };
  });

  const axisTicks = { color: theme.textMuted, font: { family: fontFamily, size: 11 } };
  const labelMode = isRadial ? 'radial' : horizontal ? 'horizontal' : stacked ? 'stacked' : isBar ? 'bar' : 'point';

  return {
    type: data.type,
    data: { labels: data.labels, datasets },
    plugins: display.showValues ? [valueLabelsPlugin(theme, fontFamily, labelMode)] : [],
    options: {
      responsive: true,
      // The card owns the height (fixed reading height in chat, `fill` in dashboards).
      maintainAspectRatio: false,
      ...(horizontal ? { indexAxis: 'y' as const } : {}),
      ...(isRadial && data.type === 'doughnut' ? { cutout: '58%' } : {}),
      interaction: isRadial
        ? { mode: 'nearest' as const, intersect: true }
        : { mode: 'index' as const, intersect: false },
      plugins: {
        legend: {
          display: data.datasets.length > 1 || isRadial,
          // Below the plot keeps radial charts centred and stays readable when narrow.
          position: isRadial ? ('bottom' as const) : ('top' as const),
          labels: { color: theme.text, font: { family: fontFamily, size: 11 }, padding: 12, usePointStyle: true },
        },
        title: { display: false },
        tooltip: {
          enabled: true,
          titleFont: { family: fontFamily, size: 11 },
          bodyFont: { family: fontFamily, size: 11 },
          backgroundColor: theme.surface,
          titleColor: theme.text,
          bodyColor: theme.text,
          borderColor: theme.edge,
          borderWidth: 1,
        },
      },
      scales: isRadial
        ? undefined
        : data.type === 'radar'
          ? {
              r: {
                angleLines: { color: theme.edge },
                grid: { color: theme.edge },
                pointLabels: { color: theme.text, font: { family: fontFamily, size: 11 } },
                ticks: { ...axisTicks, backdropColor: 'transparent', font: { family: fontFamily, size: 10 } },
              },
            }
          : {
              // The value axis carries the (recessive) grid; the category axis none.
              x: {
                stacked,
                border: { color: theme.edge },
                grid: { display: horizontal, color: theme.edge },
                ticks: axisTicks,
              },
              y: {
                stacked,
                beginAtZero: true,
                border: { color: theme.edge },
                grid: { display: !horizontal, color: theme.edge },
                ticks: axisTicks,
              },
            },
    },
  };
}

/** The mark under a Chart.js click, if any. */
export function clickedPoint(elements: ReadonlyArray<{ datasetIndex: number; index: number }>): ChartPointRef | null {
  const element = elements[0];
  return element ? { datasetIndex: element.datasetIndex, index: element.index } : null;
}
