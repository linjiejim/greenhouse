/**
 * ChartBlock — renders charts with Chart.js: rich-block ```chart fences in
 * chat, the Home workbench and Tables dashboard cards.
 *
 * Types: bar, line, pie, doughnut, radar (`ChartData`, the model-authored
 * protocol). How a chart is drawn — stacked, horizontal, area, value labels,
 * colour slots — is `display` (`ChartDisplayOptions`), set by the host and never
 * by model output. Colours are the `--t-chart-1..8` tokens (see chart-config.ts).
 * `onPointClick` makes marks clickable (dashboards drill into records).
 */

import React, { useRef, useEffect, useMemo, useState } from 'react';
import type { ChartData } from './index';
import { RichBlockShell, richBlockBodyClass } from '@greenhouse/ui/components/blocks/rich-block-shell';
import {
  buildChartConfig,
  clickedPoint,
  readChartTheme,
  type ChartDisplayOptions,
  type ChartPointRef,
} from './chart-config';

export type { ChartDisplayOptions, ChartPointRef } from './chart-config';

export function ChartBlock({
  data,
  compact = false,
  fill = false,
  display,
  onPointClick,
  ariaLabel,
}: {
  data: ChartData;
  compact?: boolean;
  fill?: boolean;
  display?: ChartDisplayOptions;
  onPointClick?: (point: ChartPointRef) => void;
  /** Accessible name for the canvas (the chart title when there is one). */
  ariaLabel?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<any>(null);
  const clickRef = useRef(onPointClick);
  clickRef.current = onPointClick;
  const [themeRevision, setThemeRevision] = useState(0);

  const isPieType = data.type === 'pie' || data.type === 'doughnut';
  const interactive = Boolean(onPointClick);

  // Stable fingerprints — prevent destroy/recreate when references change but
  // content is identical (defense-in-depth for streaming and polling).
  const dataFingerprint = useMemo(() => JSON.stringify(data), [data]);
  const displayFingerprint = useMemo(() => JSON.stringify(display ?? {}), [display]);
  const themeColors = useMemo(() => readChartTheme(), [themeRevision]); // eslint-disable-line react-hooks/exhaustive-deps -- re-read on theme change

  // Theme changes update data-theme on the root. Rebuild the canvas config so
  // labels, grids, marks and tooltips follow the active appearance.
  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setThemeRevision((value) => value + 1));
    observer.observe(root, { attributes: true, attributeFilter: ['data-theme'] });
    return () => observer.disconnect();
  }, []);

  const config = useMemo(() => {
    const fontFamily =
      typeof document === 'undefined' ? 'Nunito, sans-serif' : getComputedStyle(document.body).fontFamily;
    const base = buildChartConfig(data, { ...display, interactive }, themeColors, fontFamily);
    const options = base.options as Record<string, unknown>;
    return {
      ...base,
      options: {
        ...options,
        onClick: (_event: unknown, elements: Array<{ datasetIndex: number; index: number }>) => {
          const point = clickedPoint(elements);
          if (point) clickRef.current?.(point);
        },
        onHover: (event: { native?: { target?: EventTarget | null } }, elements: unknown[]) => {
          const target = event.native?.target;
          if (interactive && target instanceof HTMLElement) {
            target.style.cursor = elements.length > 0 ? 'pointer' : 'default';
          }
        },
      },
    };
  }, [dataFingerprint, displayFingerprint, themeColors, interactive]); // eslint-disable-line react-hooks/exhaustive-deps -- keyed on serialized data for stability

  useEffect(() => {
    if (!canvasRef.current) return;

    let mounted = true;

    // Chart.js is loaded on first use, keeping it out of the main bundle.
    import('chart.js/auto')
      .then((ChartModule) => {
        if (!mounted || !canvasRef.current) return;
        if (chartRef.current) chartRef.current.destroy();
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
  }, [config]); // Config changes only when serialized data, display options or the theme change.

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
          <canvas
            ref={canvasRef}
            className="block h-full w-full"
            role="img"
            aria-label={ariaLabel ?? data.title ?? undefined}
          />
        </div>
      </div>
    </RichBlockShell>
  );
}
