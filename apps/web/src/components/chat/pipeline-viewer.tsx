/**
 * Pipeline / tool-call visualization components.
 */

import React, { useState } from 'react';
import { getToolIcon, CheckCircle } from '../../lib/icons';
import type { PipelineStep } from '@greenhouse/types/session';

// ─── Types ───────────────────────────────────────────────

// PipelineStep is the canonical wire type emitted by the server.
export type { PipelineStep };

export interface StreamingToolCall {
  id: string;
  name: string;
  input: string;
  output?: unknown;
  status: 'calling' | 'done';
}

// ─── Tool display helpers ────────────────────────────────

const _toolLabels: Record<string, string> = {
  search: 'search',
  get_page: 'get_page',
  external_search: 'external_search',
};

/** Generate a human-readable one-line summary of tool input */
function summarizeToolInput(name: string, input: unknown): string {
  if (!input) return '';
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    switch (name) {
      case 'search':
        return `query="${obj.query || ''}"${obj.category && obj.category !== 'all' ? ` category=${obj.category}` : ''}`;
      case 'get_page':
        return `slug="${obj.slug || ''}"`;
      case 'external_search':
        return `query="${obj.query || ''}"${obj.maxResults ? ` max=${obj.maxResults}` : ''}`;
      default:
        return JSON.stringify(obj).slice(0, 80);
    }
  } catch (_err) {
    return String(input).slice(0, 80);
  }
}

/** Generate a human-readable one-line summary of tool output */
function summarizeToolOutput(name: string, output: unknown): string {
  if (!output) return '';
  try {
    const obj = typeof output === 'object' ? (output as Record<string, unknown>) : {};
    switch (name) {
      case 'search': {
        const wikiPages = obj.wiki_pages as Array<{ title: string }> | undefined;
        const found = (obj.found as number) ?? 0;
        if (wikiPages && wikiPages.length > 0) {
          const titles = wikiPages.slice(0, 3).map((p) => p.title);
          return `${found} found: ${titles.join(', ')}${wikiPages.length > 3 ? '…' : ''}`;
        }
        return `${found} results`;
      }
      case 'get_page':
        if (obj.error) return `Error: ${obj.error}`;
        return `"${obj.title || obj.slug}" (${typeof obj.content === 'string' ? obj.content.length : ((obj as any).chars ?? '?')} chars)`;
      case 'external_search': {
        const extResults = obj.results as Array<{ title: string }> | undefined;
        const extCount = (obj.resultCount as number) ?? extResults?.length ?? 0;
        if (extResults && extResults.length > 0) {
          return `${extCount} results: ${extResults
            .slice(0, 2)
            .map((r) => r.title)
            .join(', ')}${extCount > 2 ? '…' : ''}`;
        }
        return `${extCount} results`;
      }
      default:
        return JSON.stringify(output).slice(0, 100);
    }
  } catch (_err) {
    return String(output).slice(0, 100);
  }
}

// ─── Pipeline Viewer (for completed messages) ────────────

export function PipelineViewer({ steps }: { steps: PipelineStep[] }) {
  if (!steps.length) return null;
  return (
    <div className="space-y-1">
      {steps.map((step, i) => (
        <PipelineStepItem key={i} step={step} />
      ))}
    </div>
  );
}

function PipelineStepItem({ step }: { step: PipelineStep }) {
  const [expanded, setExpanded] = useState(false);
  const outputSummary = summarizeToolOutput(step.tool, step.output);

  return (
    <div className="border border-edge rounded bg-surface-raised overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs hover:bg-surface-sunken transition-colors text-left"
      >
        <span className="text-primary-500 flex-shrink-0">
          <CheckCircle size={11} />
        </span>
        <span className="flex-shrink-0">
          {(() => {
            const Icon = getToolIcon(step.tool);
            return <Icon size={11} />;
          })()}
        </span>
        <span className="font-mono text-fg-secondary flex-shrink-0 text-[11px]">{step.tool}</span>
        <span className="text-fg-faint truncate flex-1 text-[11px]">{summarizeToolInput(step.tool, step.input)}</span>
        {outputSummary && !expanded && (
          <span className="text-fg-faint truncate max-w-[180px] text-[10px]">→ {outputSummary}</span>
        )}
        <span className="text-[10px] text-fg-faint tabular-nums flex-shrink-0 ml-auto">
          {(step.duration_ms / 1000).toFixed(2)}s
        </span>
        <span className="text-fg-faint text-[9px] flex-shrink-0">{expanded ? '▼' : '▶'}</span>
      </button>
      {expanded && (
        <div className="px-2.5 pb-2 space-y-1.5 text-xs border-t border-edge pt-1.5">
          <div>
            <span className="text-fg-muted font-medium text-[10px]">Input:</span>
            <pre className="mt-0.5 text-fg-secondary bg-surface-sunken rounded p-1.5 overflow-x-auto max-h-28 overflow-y-auto text-[10px]">
              {JSON.stringify(step.input, null, 2)}
            </pre>
          </div>
          <div>
            <span className="text-fg-muted font-medium text-[10px]">Output:</span>
            <pre className="mt-0.5 text-fg-secondary bg-surface-sunken rounded p-1.5 overflow-x-auto max-h-28 overflow-y-auto text-[10px]">
              {JSON.stringify(step.output, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Streaming Pipeline (during chat) ────────────────────

export function StreamingPipeline({ toolCalls }: { toolCalls: StreamingToolCall[] }) {
  if (!toolCalls.length) return null;

  return (
    <div className="space-y-1 my-2">
      {toolCalls.map((tc) => (
        <StreamingToolCallItem key={tc.id} tc={tc} />
      ))}
    </div>
  );
}

function StreamingToolCallItem({ tc }: { tc: StreamingToolCall }) {
  const [expanded, setExpanded] = useState(false);

  // Parse input for display
  const inputSummary = summarizeToolInput(tc.name, tc.input);
  const outputSummary = tc.output ? summarizeToolOutput(tc.name, tc.output) : '';
  const isCalling = tc.status === 'calling';

  return (
    <div
      className={`rounded overflow-hidden transition-colors ${
        isCalling ? 'bg-warning-subtle/60 border border-warning' : 'bg-surface-raised border border-edge'
      }`}
    >
      <button
        onClick={() => !isCalling && setExpanded(!expanded)}
        className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-left transition-colors ${
          isCalling ? 'cursor-default' : 'hover:bg-surface-sunken'
        }`}
      >
        {isCalling ? (
          <span className="w-3 h-3 flex items-center justify-center flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          </span>
        ) : (
          <span className="text-primary-500 flex-shrink-0">
            <CheckCircle size={11} />
          </span>
        )}
        <span className="flex-shrink-0">
          {(() => {
            const Icon = getToolIcon(tc.name);
            return <Icon size={11} />;
          })()}
        </span>
        <span className={`font-mono flex-shrink-0 text-[11px] ${isCalling ? 'text-warning' : 'text-fg-secondary'}`}>
          {tc.name}
        </span>

        {/* Input summary */}
        {inputSummary && <span className="text-fg-faint truncate text-[11px]">{inputSummary}</span>}

        {/* Output summary inline when collapsed & done */}
        {!isCalling && outputSummary && !expanded && (
          <span className="text-fg-faint truncate max-w-[180px] text-[10px] hidden md:inline">→ {outputSummary}</span>
        )}

        <span className="ml-auto flex-shrink-0">
          {isCalling ? (
            <span className="text-[10px] text-warning font-medium">calling…</span>
          ) : (
            <span className="text-fg-faint text-[9px]">{expanded ? '▼' : '▶'}</span>
          )}
        </span>
      </button>

      {/* Expanded detail */}
      {expanded && !isCalling && (
        <div className="px-2.5 pb-2 space-y-1.5 text-xs border-t border-edge pt-1.5">
          {tc.input && (
            <div>
              <span className="text-fg-muted font-medium text-[10px]">Input:</span>
              <pre className="mt-0.5 text-fg-secondary bg-surface-sunken rounded p-1.5 overflow-x-auto max-h-24 overflow-y-auto text-[10px]">
                {formatJson(tc.input)}
              </pre>
            </div>
          )}
          {!!tc.output && (
            <div>
              <span className="text-fg-muted font-medium text-[10px]">Output:</span>
              <pre className="mt-0.5 text-fg-secondary bg-surface-sunken rounded p-1.5 overflow-x-auto max-h-28 overflow-y-auto text-[10px]">
                {typeof tc.output === 'string' ? tc.output : JSON.stringify(tc.output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch (_err) {
    return s;
  }
}
