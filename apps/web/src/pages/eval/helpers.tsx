/**
 * Eval page shared helpers — score styling, utility components.
 */

import React from 'react';
import { getCategoryIcon, type LucideIcon } from '../../lib/icons';

// Re-export safeParse from shared utils
export { safeParse } from '../../lib/utils';

// ─── Score color helpers ─────────────────────────────────

export function scoreColor(score: number | null): string {
  if (score == null) return 'text-fg-faint';
  if (score >= 8) return 'text-success';
  if (score >= 6) return 'text-warning';
  return 'text-danger';
}

export function scoreBg(score: number | null): string {
  if (score == null) return 'bg-surface-muted';
  if (score >= 8) return 'bg-success-subtle';
  if (score >= 6) return 'bg-warning-subtle';
  return 'bg-danger-subtle';
}

export function ScoreCell({ score, label }: { score: number | null; label?: string }) {
  return (
    <div className={`text-center px-1.5 py-0.5 rounded ${scoreBg(score)}`}>
      <span className={`text-sm font-medium ${scoreColor(score)}`}>{score != null ? score.toFixed(1) : '—'}</span>
      {label && <div className="text-[9px] text-fg-faint">{label}</div>}
    </div>
  );
}

export function entityIcon(category: string): LucideIcon {
  return getCategoryIcon(category);
}

export function MetricBox({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-surface-sunken rounded-lg px-3 py-2 text-center">
      <div className="text-[10px] text-fg-faint mb-0.5">{label}</div>
      <div className="text-sm font-medium text-fg-secondary">{value}</div>
      {sub && <div className="text-[10px] text-fg-faint">{sub}</div>}
    </div>
  );
}
