/**
 * ToolCallRenderer — the collapsible "N tool calls" trace block.
 *
 * Renders process/trace tool calls as generic rows (ToolCallCard). Rich "artifact"
 * outputs (eval cards, the ask_user form, page-update diffs, generated images) are
 * filtered out here and rendered in the message body by <BodyArtifacts> instead —
 * so a message whose only tool call is an eval shows no trace block at all.
 *
 * Used by both the Chat page (variant 'full') and the Agent Panel (variant 'compact').
 */

import React, { useState } from 'react';
import { CheckCircle, ChevronDown } from '../../lib/icons';
import { ToolCallCard } from './tool-call-card';
import { isArtifactCall } from './body-artifacts';

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
  onViewWiki?: (slug: string) => void;
  onViewSource?: (id: string, category?: string) => void;
}

// ─── Component ───────────────────────────────────────────

export function ToolCallRenderer({
  calls,
  variant,
  defaultCollapsed,
  onViewWiki,
  onViewSource,
}: ToolCallRendererProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed ?? false);

  // Artifact calls render in the message body via <BodyArtifacts>; keep them out
  // of the trace block so they aren't shown twice (and so a body-only artifact
  // doesn't leave an empty "0 tool calls" header here).
  const traceCalls = calls.filter((c) => !isArtifactCall(c));
  if (!traceCalls.length) return null;

  const doneCount = traceCalls.filter((c) => c.output || c.status === 'done').length;
  const callingCount = traceCalls.length - doneCount;

  return (
    <div>
      {/* Summary header — styled to match the "Thinking" toggle */}
      <button
        onClick={() => setCollapsed(!collapsed)}
        className="flex items-center gap-1 text-[11px] text-fg-faint hover:text-fg-secondary transition-colors text-left py-0.5"
      >
        {callingCount > 0 ? (
          <span className="w-2 h-2 rounded-full bg-warning animate-pulse flex-shrink-0" />
        ) : (
          <CheckCircle size={12} className="text-primary-500 flex-shrink-0" />
        )}
        <span>
          {traceCalls.length} tool call{traceCalls.length !== 1 ? 's' : ''}
        </span>
        {callingCount > 0 && <span className="text-warning">{callingCount} running</span>}
        <ChevronDown size={11} className={`transition-transform ${collapsed ? '' : 'rotate-180'}`} />
      </button>

      {/* Tool call items — scrollable so a long run can't dominate the thread.
          Rows share light horizontal divider lines instead of each having its own
          box. (This build's Tailwind doesn't ship `divide-*`, so we draw the lines
          with a top border on the list + a bottom border per row.) */}
      {!collapsed && (
        <div className="mt-1 max-h-80 overflow-y-auto border-t border-edge/50">
          {traceCalls.map((call, i) => (
            <div key={i} className="border-b border-edge/50">
              <ToolCallCard call={call} variant={variant} onViewWiki={onViewWiki} onViewSource={onViewSource} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
