/**
 * ToolCallRenderer — the collapsible "N tool calls" trace block.
 *
 * Renders process/trace tool calls as generic rows (ToolCallCard). Rich "artifact"
 * outputs whose card restates the whole call (eval cards, the ask_user form,
 * page-update diffs) are filtered out here and rendered in the message body by
 * <BodyArtifacts> instead — so a message whose only tool call is an eval shows no
 * trace block at all. A generated image still gets a row, since its artifact is just
 * the picture; see `replacesTraceRow`.
 *
 * Used by both the Chat page (variant 'full') and the Agent Panel (variant 'compact').
 */

import React, { useState } from 'react';
import { CheckCircle, ChevronDown } from '../../lib/icons';
import { ToolCallCard, summarizeToolInput, toolDisplayName } from './tool-call-card';
import { replacesTraceRow } from './body-artifacts';
import { useT } from '../../lib/i18n';
import { useAuthStore } from '../../stores';

// ─── Types ───────────────────────────────────────────────

export interface ToolCall {
  name: string;
  input: unknown;
  output?: unknown;
  status?: 'calling' | 'done';
  durationMs?: number;
  step?: number;
}

interface ToolCallRendererProps {
  calls: ToolCall[];
  /** 'full' = Chat page (shows timing), 'compact' = Agent Panel */
  variant: 'full' | 'compact';
  defaultCollapsed?: boolean;
}

// ─── Component ───────────────────────────────────────────

export function ToolCallRenderer({ calls, variant, defaultCollapsed }: ToolCallRendererProps) {
  const t = useT();
  const canUseWorkflow = useAuthStore((state) => state.currentUser?.role === 'super');
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);

  // Artifact calls whose card restates the whole call render in the message body via
  // <BodyArtifacts> only; keep them out of the trace block so they aren't shown twice
  // (and so a body-only artifact doesn't leave an empty "0 tool calls" header here).
  const traceCalls = calls
    .filter((c) => c.name !== 'workflow_plan' || canUseWorkflow)
    .filter((c) => !replacesTraceRow(c));
  if (!traceCalls.length) return null;

  const doneCount = traceCalls.filter((c) => c.output || c.status === 'done').length;
  const callingCount = traceCalls.length - doneCount;
  const currentCall = [...traceCalls].reverse().find((call) => call.status === 'calling');
  const currentSummary = currentCall
    ? [toolDisplayName(currentCall.name), summarizeToolInput(currentCall.name, currentCall.input)]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div>
      {/* Summary header — styled to match the "Thinking" toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex max-w-full min-w-0 items-center gap-1 py-0.5 text-left text-[11px] text-fg-faint transition-colors hover:text-fg-secondary"
      >
        {callingCount > 0 ? (
          <span className="w-2 h-2 rounded-full bg-warning animate-pulse flex-shrink-0" />
        ) : (
          <CheckCircle size={12} className="text-primary-500 flex-shrink-0" />
        )}
        <span className="flex-shrink-0">{t('chat.toolCalls', { count: traceCalls.length })}</span>
        {callingCount > 0 && (
          <span className="flex-shrink-0 text-warning">{t('chat.toolRunningCount', { count: callingCount })}</span>
        )}
        <ChevronDown size={11} className={`flex-shrink-0 transition-transform ${collapsed ? '' : 'rotate-180'}`} />
        {collapsed && callingCount > 0 && currentSummary && (
          <span
            key={`${currentCall?.name}:${currentSummary}:${callingCount}`}
            className="ml-1 min-w-0 truncate text-[10px] text-fg-faint animate-fade-in"
          >
            {currentSummary}
          </span>
        )}
      </button>

      {/* Tool call items — scrollable so a long run can't dominate the thread.
          Rows share light horizontal divider lines instead of each having its own
          box. (This build's Tailwind doesn't ship `divide-*`, so we draw the lines
          with a top border on the list + a bottom border per row.) */}
      {!collapsed && (
        <div className="mt-1 max-h-80 overflow-y-auto border-t border-edge/50">
          {traceCalls.map((call, i) => (
            <div key={i} className="border-b border-edge/50">
              <ToolCallCard call={call} variant={variant} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
