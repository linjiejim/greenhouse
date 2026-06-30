/**
 * ChartBlock — renders charts from custom code fence using Chart.js.
 *
 * Supported types: bar, line, pie, doughnut, radar.
 * Uses Chart.js auto-registration via CDN import.
 */

import React, { useRef, useEffect, useMemo } from 'react';
import type { ChartData } from './index';
import { CHART_PALETTE } from '../../lib/utils';

// ─── Default Colors ──────────────────────────────────────
// Chart.js renders to canvas, so it needs literal color strings rather than
// Tailwind classes. We derive both from the shared CHART_PALETTE `rgb` triplets
// (the single source of truth — see lib/utils.ts), keeping fills semi-transparent
// and borders solid.

const fill = (rgb: string) => `rgba(${rgb}, 0.6)`;
const solid = (rgb: string) => `rgb(${rgb})`;

const PIE_PALETTE = CHART_PALETTE.map((c) => fill(c.rgb));
const PIE_BORDER_PALETTE = CHART_PALETTE.map((c) => solid(c.rgb));

// ─── Component ───────────────────────────────────────────

export function ChartBlock({ data }: { data: ChartData }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null);

  const isPieType = data.type === 'pie' || data.type === 'doughnut';

  // Stable fingerprint of chart data — prevents destroy/recreate when data reference
  // changes but content is identical (defense-in-depth for streaming scenarios).
  const dataFingerprint = useMemo(() => JSON.stringify(data), [data]);

  // Build Chart.js config
  const config = useMemo(() => {
    const datasets = data.datasets.map((ds, i) => {
      const color = CHART_PALETTE[i % CHART_PALETTE.length];

      if (isPieType) {
        return {
          label: ds.label,
          data: ds.data,
          backgroundColor: ds.backgroundColor || PIE_PALETTE.slice(0, ds.data.length),
          borderColor: ds.borderColor || PIE_BORDER_PALETTE.slice(0, ds.data.length),
          borderWidth: 1,
        };
      }

      return {
        label: ds.label,
        data: ds.data,
        backgroundColor: ds.backgroundColor || fill(color.rgb),
        borderColor: ds.borderColor || solid(color.rgb),
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
        maintainAspectRatio: true,
        plugins: {
          legend: {
            display: data.datasets.length > 1 || isPieType,
            position: isPieType ? ('right' as const) : ('top' as const),
            labels: { font: { size: 11 }, padding: 12 },
          },
          title: {
            display: false, // We render title ourselves
          },
          tooltip: {
            enabled: true,
            titleFont: { size: 11 },
            bodyFont: { size: 11 },
          },
        },
        scales:
          isPieType || data.type === 'radar'
            ? undefined
            : {
                x: { grid: { display: false }, ticks: { font: { size: 11 } } },
                y: { grid: { color: 'rgba(0,0,0,0.05)' }, ticks: { font: { size: 11 } } },
              },
      },
    };
  }, [dataFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on serialized data for stability

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
  }, [dataFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on serialized data for stability

  return (
    <div className="my-3 border border-edge rounded-lg overflow-hidden bg-surface-raised">
      {data.title && (
        <div className="px-3 py-2 bg-surface-sunken border-b border-edge">
          <span className="text-xs font-semibold text-fg-secondary">{data.title}</span>
        </div>
      )}
      <div className="px-4 py-3" style={{ maxHeight: '360px' }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  );
}
