/**
 * ChartBlock — renders charts from custom code fence using Chart.js.
 *
 * Supported types: bar, line, pie, doughnut, radar.
 * Uses the bundled Chart.js module with auto-registration.
 */

import React, { useRef, useEffect, useMemo, useState } from 'react';
import type { ChartData } from './index';
import { CHART_PALETTE } from '../../lib/utils';
import { RichBlockShell, richBlockBodyClass } from './rich-block-shell';

// ─── Default Colors ──────────────────────────────────────
// Chart.js renders to canvas, so it needs literal color strings rather than
// Tailwind classes. We derive both from the shared CHART_PALETTE `rgb` triplets
// (the single source of truth — see lib/utils.ts), keeping fills semi-transparent
// and borders solid.

const translucent = (rgb: string) => `rgba(${rgb}, 0.48)`;
const solid = (rgb: string) => `rgb(${rgb})`;

const PIE_PALETTE = CHART_PALETTE.map((c) => translucent(c.rgb));
const PIE_BORDER_PALETTE = CHART_PALETTE.map((c) => solid(c.rgb));

function readThemeColor(variable: string, fallback: string): string {
  if (typeof document === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(variable).trim() || fallback;
}

function readChartTheme(_revision: number) {
  return {
    text: readThemeColor('--t-fg-secondary', '#455147'),
    textMuted: readThemeColor('--t-fg-muted', '#5f6a61'),
    edge: readThemeColor('--t-edge', '#e6ece3'),
    surface: readThemeColor('--t-surface-raised', '#ffffff'),
  };
}

// ─── Component ───────────────────────────────────────────

export function ChartBlock({
  data,
  compact = false,
  fill = false,
}: {
  data: ChartData;
  compact?: boolean;
  fill?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null);
  const [themeRevision, setThemeRevision] = useState(0);

  const isPieType = data.type === 'pie' || data.type === 'doughnut';

  // Stable fingerprint of chart data — prevents destroy/recreate when data reference
  // changes but content is identical (defense-in-depth for streaming scenarios).
  const dataFingerprint = useMemo(() => JSON.stringify(data), [data]);
  const themeColors = useMemo(() => readChartTheme(themeRevision), [themeRevision]);

  // Theme changes update data-theme on the root. Rebuild the canvas config so
  // labels, grids, and tooltips stay legible in both Greenhouse modes.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setThemeRevision((value) => value + 1));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  // Build Chart.js config
  const config = useMemo(() => {
    const datasets = data.datasets.map((ds, i) => {
      const color = CHART_PALETTE[i % CHART_PALETTE.length];

      if (isPieType) {
        return {
          label: ds.label,
          data: ds.data,
          backgroundColor: PIE_PALETTE.slice(0, ds.data.length),
          borderColor: PIE_BORDER_PALETTE.slice(0, ds.data.length),
          borderWidth: 1,
        };
      }

      return {
        label: ds.label,
        data: ds.data,
        // Rich blocks are model-authored, so accepting arbitrary color literals
        // would let every response bypass the product theme. Always normalize to
        // the shared Greenhouse palette.
        backgroundColor: translucent(color.rgb),
        borderColor: solid(color.rgb),
        borderWidth: data.type === 'line' ? 2 : 1,
        tension: data.type === 'line' ? 0.3 : undefined,
        fill: data.type === 'line' ? false : undefined,
        pointRadius: data.type === 'line' ? 3 : undefined,
      };
    });

    return {
      type: data.type,
      data: {
        labels: data.labels,
        datasets,
      },
      options: {
        responsive: true,
        // The rich-block card can be much wider than Chart.js' default 2:1
        // aspect ratio. Let the explicit responsive viewport below own height
        // so cartesian charts use the full message width.
        maintainAspectRatio: false,
        plugins: {
          legend: {
            display: data.datasets.length > 1 || isPieType,
            // A right-hand legend pins radial charts to the left on wide chat
            // messages. Keeping it below the plot centers the chart and remains
            // readable when the message becomes narrow.
            position: isPieType ? ('bottom' as const) : ('top' as const),
            labels: { color: themeColors.text, font: { size: 11 }, padding: 12 },
          },
          title: {
            display: false, // We render title ourselves
          },
          tooltip: {
            enabled: true,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
            backgroundColor: themeColors.surface,
            titleColor: themeColors.text,
            bodyColor: themeColors.text,
            borderColor: themeColors.edge,
            borderWidth: 1,
          },
        },
        scales: isPieType
          ? undefined
          : data.type === 'radar'
            ? {
                r: {
                  angleLines: { color: themeColors.edge },
                  grid: { color: themeColors.edge },
                  pointLabels: { color: themeColors.text, font: { size: 11 } },
                  ticks: {
                    color: themeColors.textMuted,
                    backdropColor: 'transparent',
                    font: { size: 10 },
                  },
                },
              }
            : {
                x: {
                  border: { color: themeColors.edge },
                  grid: { display: false },
                  ticks: { color: themeColors.textMuted, font: { size: 11 } },
                },
                y: {
                  border: { color: themeColors.edge },
                  grid: { color: themeColors.edge },
                  ticks: { color: themeColors.textMuted, font: { size: 11 } },
                },
              },
      },
    };
  }, [dataFingerprint, themeColors]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on serialized data for stability

  useEffect(() => {
    if (!canvasRef.current) return;

    let mounted = true;

    // Dynamic import of Chart.js (loaded via CDN import map)
    import('chart.js/auto')
      .then((ChartModule) => {
        if (!mounted || !canvasRef.current) return;

        // Destroy previous chart instance
        if (chartRef.current) {
          chartRef.current.destroy();
        }

        const Chart = ChartModule.default || (ChartModule as any).Chart || ChartModule;
        chartRef.current = new Chart(canvasRef.current, config as any);
      })
      .catch((err) => {
        console.error('Failed to load Chart.js:', err);
      });

    return () => {
      mounted = false;
      if (chartRef.current) {
        chartRef.current.destroy();
        chartRef.current = null;
      }
    };
  }, [config]); // Config changes only when serialized data or the active theme changes.

  return (
    <RichBlockShell
      compact={compact}
      header={data.title ? <span className="text-xs font-semibold text-fg">{data.title}</span> : undefined}
      className={fill ? 'flex h-full min-h-0 flex-col' : ''}
    >
      <div className={`${richBlockBodyClass(compact)} ${fill ? 'min-h-0 flex-1' : ''}`}>
        <div
          data-chart-viewport={isPieType ? 'radial' : 'cartesian'}
          className={`relative w-full ${
            fill ? 'h-full min-h-0' : compact ? 'h-[260px] sm:h-[320px]' : 'h-[300px] sm:h-[360px]'
          }`}
        >
          <canvas ref={canvasRef} className="block h-full w-full" />
        </div>
      </div>
    </RichBlockShell>
  );
}
