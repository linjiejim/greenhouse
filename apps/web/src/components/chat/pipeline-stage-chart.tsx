/**
 * Pipeline Stage Chart — horizontal stacked bar showing each pipeline stage's
 * timing and proportion. Used in Chat messages and Eval result details.
 */

import React, { useState, useMemo } from 'react';
import type { PipelineStep } from './pipeline-viewer';

// ─── Stage Colors ────────────────────────────────────────

const STAGE_COLORS = [
  { bg: 'bg-primary-500', text: 'text-primary-fg-strong', light: 'bg-primary-subtle' },
  { bg: 'bg-info', text: 'text-info', light: 'bg-info-subtle' },
  { bg: 'bg-warning', text: 'text-warning', light: 'bg-warning-subtle' },
  { bg: 'bg-purple-500', text: 'text-purple-700', light: 'bg-purple-50' },
  { bg: 'bg-danger', text: 'text-danger', light: 'bg-danger-subtle' },
  { bg: 'bg-success', text: 'text-success', light: 'bg-success-subtle' },
  { bg: 'bg-orange-500', text: 'text-orange-700', light: 'bg-orange-50' },
  { bg: 'bg-cyan-500', text: 'text-cyan-700', light: 'bg-cyan-50' },
];

const TOOL_LABELS: Record<string, string> = {
  search: 'Search',
  get_page: 'Read Page',
};

// ─── Types ───────────────────────────────────────────────

interface StageInfo {
  tool: string;
  label: string;
  durationMs: number;
  percent: number;
  color: (typeof STAGE_COLORS)[0];
}

interface PipelineStageChartProps {
  steps: PipelineStep[];
  totalDurationMs?: number | null;
  /** Compact mode — hide legend, thinner bar */
  compact?: boolean;
  className?: string;
}

// ─── Component ───────────────────────────────────────────

export function PipelineStageChart({ steps, totalDurationMs, compact, className = '' }: PipelineStageChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  const {
    stages,
    pipelineMs: _pipelineMs,
    otherMs,
    total,
  } = useMemo(() => {
    if (!steps.length) return { stages: [], pipelineMs: 0, otherMs: 0, total: 0 };

    // Aggregate by tool name
    const toolMap = new Map<string, number>();
    const toolOrder: string[] = [];
    let pipelineSum = 0;
    for (const step of steps) {
      const existing = toolMap.get(step.tool) ?? 0;
      if (!toolMap.has(step.tool)) toolOrder.push(step.tool);
      toolMap.set(step.tool, existing + step.duration_ms);
      pipelineSum += step.duration_ms;
    }

    const total = totalDurationMs && totalDurationMs > pipelineSum ? totalDurationMs : pipelineSum;
    const otherMs = total - pipelineSum;

    const stages: StageInfo[] = toolOrder.map((tool, i) => ({
      tool,
      label: TOOL_LABELS[tool] || `${tool}`,
      durationMs: toolMap.get(tool)!,
      percent: total > 0 ? (toolMap.get(tool)! / total) * 100 : 0,
      color: STAGE_COLORS[i % STAGE_COLORS.length],
    }));

    return { stages, pipelineMs: pipelineSum, otherMs, total };
  }, [steps, totalDurationMs]);

  if (stages.length === 0) return null;

  const barHeight = compact ? 'h-1.5' : 'h-2';
  const otherPercent = total > 0 ? (otherMs / total) * 100 : 0;

  return (
    <div className={`${className}`}>
      {/* Header + Bar inline */}
      <div className="flex items-center gap-2 mb-1">
        {/* Stacked Bar */}
        <div className={`flex-1 ${barHeight} rounded-full overflow-hidden flex bg-surface-muted`}>
          {stages.map((stage, i) => (
            <div
              key={stage.tool}
              className={`${stage.color.bg} transition-opacity relative ${hoveredIdx != null && hoveredIdx !== i ? 'opacity-40' : ''}`}
              style={{ width: `${Math.max(stage.percent, 0.5)}%` }}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
              title={`${stage.label}: ${(stage.durationMs / 1000).toFixed(2)}s (${stage.percent.toFixed(1)}%)`}
            />
          ))}
          {otherMs > 0 && (
            <div
              className={`bg-edge-strong transition-opacity ${hoveredIdx != null ? 'opacity-40' : ''}`}
              style={{ width: `${Math.max(otherPercent, 0.5)}%` }}
              title={`LLM / Other: ${(otherMs / 1000).toFixed(2)}s (${otherPercent.toFixed(1)}%)`}
            />
          )}
        </div>
      </div>

      {/* Legend */}
      {!compact && (
        <div className="flex items-center gap-3 mt-1.5 flex-wrap">
          {stages.map((stage, i) => (
            <div
              key={stage.tool}
              className={`flex items-center gap-1 text-[10px] cursor-default rounded px-1 py-0.5 transition-colors ${
                hoveredIdx === i ? stage.color.light : ''
              }`}
              onMouseEnter={() => setHoveredIdx(i)}
              onMouseLeave={() => setHoveredIdx(null)}
            >
              <span className={`w-2 h-2 rounded-sm ${stage.color.bg} inline-block`} />
              <span className={`${stage.color.text} font-medium`}>{stage.label}</span>
              <span className="text-fg-faint">{(stage.durationMs / 1000).toFixed(2)}s</span>
              <span className="text-fg-faint">({stage.percent.toFixed(0)}%)</span>
            </div>
          ))}
          {otherMs > 0 && (
            <div className="flex items-center gap-1 text-[10px]">
              <span className="w-2 h-2 rounded-sm bg-edge-strong inline-block" />
              <span className="text-fg-muted font-medium">LLM / Other</span>
              <span className="text-fg-faint">{(otherMs / 1000).toFixed(2)}s</span>
              <span className="text-fg-faint">({otherPercent.toFixed(0)}%)</span>
            </div>
          )}
        </div>
      )}

      {/* Tooltip (compact mode) */}
      {compact && hoveredIdx != null && (
        <div className="mt-1 text-[10px] text-fg-muted">
          {stages[hoveredIdx].label}: {(stages[hoveredIdx].durationMs / 1000).toFixed(2)}s (
          {stages[hoveredIdx].percent.toFixed(0)}%)
        </div>
      )}
    </div>
  );
}
