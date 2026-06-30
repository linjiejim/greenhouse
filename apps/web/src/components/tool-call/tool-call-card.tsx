/**
 * ToolCallCard — unified tool call display card.
 *
 * Merges the best of:
 * - pipeline-viewer.tsx: timing display, step numbers
 * - agent-tools.tsx: expandable wiki/source references, input/output summaries
 */

import React, { useState } from 'react';
import { getToolIcon, CheckCircle, AlertTriangle, ClipboardList } from '../../lib/icons';
import type { ToolCall } from './index';

// ─── Summary Helpers ─────────────────────────────────────

/** Human-readable one-line summary of tool input */
export function summarizeToolInput(name: string, input: unknown): string {
  if (!input) return '';
  try {
    const obj = typeof input === 'string' ? JSON.parse(input) : input;
    switch (name) {
      case 'search':
        return `"${obj.query || ''}"${obj.category && obj.category !== 'all' ? ` category=${obj.category}` : ''}`;
      case 'get_page':
        return `"${obj.slug || ''}"`;
      case 'external_search':
        return `"${obj.query || ''}"${obj.maxResults ? ` max=${obj.maxResults}` : ''}`;
      default:
        return JSON.stringify(obj).slice(0, 80);
    }
  } catch (_err) {
    return String(input).slice(0, 80);
  }
}

/** Human-readable one-line summary of tool output */
export function summarizeToolOutput(name: string, output: unknown): string {
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

// ─── Component ───────────────────────────────────────────

interface ToolCallCardProps {
  call: ToolCall;
  variant: 'full' | 'compact';
  onViewWiki?: (slug: string) => void;
  onViewSource?: (id: string, category?: string) => void;
}

export function ToolCallCard({ call, variant, onViewWiki, onViewSource }: ToolCallCardProps) {
  const [expanded, setExpanded] = useState(false);
  const ToolIcon = getToolIcon(call.name);
  const output = call.output as Record<string, unknown> | undefined;
  const isLoading = !output && call.status === 'calling';
  const hasError = output?.error;

  const inputSummary = summarizeToolInput(call.name, call.input);
  const outputSummary = output ? summarizeToolOutput(call.name, output) : '';

  // Expandable wiki/source references from search results
  const wikiPages =
    call.name === 'search' && output
      ? (output.wiki_pages as Array<{ slug: string; title: string; category: string }>) || []
      : [];
  const sourceDocs =
    call.name === 'search' && output
      ? (output.source_docs as Array<{ source_id: string; title: string; category: string }>) || []
      : [];
  const hasExpandableContent = wikiPages.length > 0 || sourceDocs.length > 0 || (!isLoading && output);

  return (
    <div
      className={`overflow-hidden transition-colors ${
        isLoading ? 'bg-warning-subtle/40' : hasError ? 'bg-danger-subtle/40' : ''
      }`}
    >
      <button
        onClick={() => hasExpandableContent && !isLoading && setExpanded(!expanded)}
        className={`w-full flex items-center gap-1.5 px-2 py-1 text-xs text-left transition-colors ${
          isLoading ? 'cursor-default' : hasExpandableContent ? 'hover:bg-surface-muted/60' : 'cursor-default'
        }`}
      >
        {isLoading ? (
          <span className="w-3 h-3 flex items-center justify-center flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-warning animate-pulse" />
          </span>
        ) : hasError ? (
          <AlertTriangle size={11} className="text-danger flex-shrink-0" />
        ) : (
          <CheckCircle size={11} className="text-primary-500 flex-shrink-0" />
        )}
        <span className="flex-shrink-0">
          <ToolIcon size={11} />
        </span>
        <span className={`font-mono flex-shrink-0 text-[11px] ${isLoading ? 'text-warning' : 'text-fg-secondary'}`}>
          {call.name}
        </span>
        {inputSummary && <span className="text-fg-faint truncate text-[11px]">{inputSummary}</span>}

        {/* Output summary when collapsed */}
        {outputSummary && !expanded && (
          <span className="text-fg-faint truncate max-w-[180px] text-[10px] hidden md:inline">→ {outputSummary}</span>
        )}

        {/* Duration (full variant only) */}
        {variant === 'full' && call.durationMs != null && (
          <span className="text-[10px] text-fg-faint tabular-nums flex-shrink-0 ml-auto mr-1">
            {(call.durationMs / 1000).toFixed(2)}s
          </span>
        )}

        <span className="flex-shrink-0">
          {isLoading ? (
            <span className="text-[10px] text-warning font-medium">calling…</span>
          ) : hasExpandableContent ? (
            <span className="text-fg-faint text-[9px]">{expanded ? '▼' : '▶'}</span>
          ) : null}
        </span>
      </button>

      {/* Expanded content */}
      {expanded && !isLoading && (
        <div className="px-2.5 pb-2 border-t border-edge pt-1.5 space-y-1.5">
          {/* Wiki/source reference badges */}
          {wikiPages.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {wikiPages.slice(0, 8).map((p) => (
                <button
                  key={p.slug}
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewWiki?.(p.slug);
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary-subtle text-primary-fg-strong border border-primary-edge hover:bg-primary-subtle-hover transition-colors truncate max-w-[150px]"
                >
                  {p.title}
                </button>
              ))}
            </div>
          )}
          {sourceDocs.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {sourceDocs.slice(0, 6).map((s) => (
                <button
                  key={s.source_id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewSource?.(s.source_id, s.category);
                  }}
                  className="text-[10px] px-1.5 py-0.5 rounded-full bg-surface-muted text-fg-secondary border border-edge hover:bg-surface-muted transition-colors truncate max-w-[150px] inline-flex items-center gap-0.5"
                >
                  <ClipboardList size={9} /> {s.title}
                </button>
              ))}
            </div>
          )}

          {/* Raw input/output JSON */}
          {!!call.input && (
            <div>
              <span className="text-fg-muted font-medium text-[10px]">Input:</span>
              <pre className="mt-0.5 text-fg-secondary bg-surface-sunken rounded p-1.5 overflow-x-auto max-h-28 overflow-y-auto text-[10px]">
                {formatJson(call.input)}
              </pre>
            </div>
          )}
          {output && (
            <div>
              <span className="text-fg-muted font-medium text-[10px]">Output:</span>
              <pre className="mt-0.5 text-fg-secondary bg-surface-sunken rounded p-1.5 overflow-x-auto max-h-28 overflow-y-auto text-[10px]">
                {typeof output === 'string' ? output : JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatJson(input: unknown): string {
  if (typeof input === 'string') {
    try {
      return JSON.stringify(JSON.parse(input), null, 2);
    } catch (_err) {
      return input;
    }
  }
  return JSON.stringify(input, null, 2);
}
