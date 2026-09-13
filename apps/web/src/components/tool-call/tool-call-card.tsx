/**
 * ToolCallCard — unified tool call display card.
 *
 * Merges the best of:
 * - chat messages: timing display and step numbers
 * - agent-tools.tsx: expandable wiki/source references, input/output summaries
 */

import { useState } from 'react';
import { Drawer, IconButton } from '../ui';
import { getToolIcon, CheckCircle, AlertTriangle, ChevronRight, X } from '../../lib/icons';
import type { ToolCall } from './index';
import { useT } from '../../lib/i18n';

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
      case 'generate_image': {
        // The prompt is a paragraph, so lead with the parameters that fit on one line.
        const refs = Array.isArray(obj.images) ? obj.images.length : 0;
        const parts = [obj.size, refs ? `${refs} ref${refs > 1 ? 's' : ''}` : null].filter(Boolean);
        return `${parts.join(' · ')}${parts.length ? ' — ' : ''}"${String(obj.prompt || '').slice(0, 60)}…"`;
      }
      default: {
        const action = typeof obj.action === 'string' ? humanizeIdentifier(obj.action) : '';
        const focus = [obj.query, obj.title, obj.keyword, obj.session_id, obj.project_id].find(
          (value) => typeof value === 'string' || typeof value === 'number',
        );
        return [action, focus != null ? String(focus).slice(0, 70) : ''].filter(Boolean).join(' · ');
      }
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
      case 'generate_image': {
        if (obj.error) return `Error: ${obj.error}`;
        const cost = obj.estimated_cost_usd;
        return [obj.filename, obj.size, typeof cost === 'number' ? `~$${cost.toFixed(3)}` : null]
          .filter(Boolean)
          .join(' · ');
      }
      default: {
        if (typeof obj.error === 'string') return obj.error;
        const count = [obj.found, obj.total, obj.count, obj.resultCount].find((value) => typeof value === 'number');
        if (typeof count === 'number') return String(count);
        return '';
      }
    }
  } catch (_err) {
    return String(output).slice(0, 100);
  }
}

function humanizeIdentifier(value: string): string {
  return value.replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Friendly tool label used in both the collapsed live summary and detail rows. */
export function toolDisplayName(name: string): string {
  const aliases: Record<string, string> = {
    workbench_query: 'Workbench',
    workbench_mutation: 'Workbench',
    external_search: 'Web search',
    session_history: 'Conversation history',
    session_query: 'Conversations',
    project_query: 'Projects',
    knowledge_query: 'Knowledge',
    tables_query: 'Tables',
  };
  return aliases[name] ?? humanizeIdentifier(name);
}

// ─── Component ───────────────────────────────────────────

interface ToolCallCardProps {
  call: ToolCall;
  variant: 'full' | 'compact';
}

export function ToolCallCard({ call, variant }: ToolCallCardProps) {
  const t = useT();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const ToolIcon = getToolIcon(call.name);
  const output = call.output;
  const outputRecord = output && typeof output === 'object' ? (output as Record<string, unknown>) : undefined;
  const isLoading = output === undefined && call.status === 'calling';
  const hasError = outputRecord?.error;

  const inputSummary = summarizeToolInput(call.name, call.input);
  const outputSummary = output !== undefined ? summarizeToolOutput(call.name, output) : '';

  return (
    <>
      <button
        type="button"
        onClick={() => setDetailsOpen(true)}
        className={`flex w-full items-center gap-1.5 px-2 py-1 text-left text-xs transition-colors hover:bg-surface-muted/60 ${
          isLoading ? 'bg-warning-subtle/40' : hasError ? 'bg-danger-subtle/40' : ''
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
        <span className={`flex-shrink-0 text-[11px] ${isLoading ? 'text-warning' : 'text-fg-secondary'}`}>
          {toolDisplayName(call.name)}
        </span>
        {inputSummary && <span className="min-w-0 truncate text-[11px] text-fg-faint">{inputSummary}</span>}
        {outputSummary && (
          <span className="hidden max-w-[180px] truncate text-[10px] text-fg-faint md:inline">→ {outputSummary}</span>
        )}

        {/* Duration (full variant only) */}
        {variant === 'full' && call.durationMs != null && (
          <span className="text-[10px] text-fg-faint tabular-nums flex-shrink-0 ml-auto mr-1">
            {(call.durationMs / 1000).toFixed(2)}s
          </span>
        )}

        <span className="flex-shrink-0">
          {isLoading ? <span className="text-[10px] font-medium text-warning">{t('chat.toolRunning')}</span> : null}
        </span>
      </button>

      <Drawer
        open={detailsOpen}
        onClose={() => setDetailsOpen(false)}
        side="right"
        width={480}
        ariaLabel={t('chat.toolCallDetails')}
      >
        <div className="flex flex-shrink-0 items-center gap-2 border-b border-edge px-4 py-3">
          <ToolIcon size={15} className="text-fg-muted" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-fg">{toolDisplayName(call.name)}</p>
            <p className="truncate text-xs text-fg-faint">{inputSummary || call.name}</p>
          </div>
          <IconButton label={t('common.close')} onClick={() => setDetailsOpen(false)} tooltipMode="portal">
            <X size={16} />
          </IconButton>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            {isLoading ? (
              <span className="h-2 w-2 animate-pulse rounded-full bg-warning" />
            ) : hasError ? (
              <AlertTriangle size={12} className="text-danger" />
            ) : (
              <CheckCircle size={12} />
            )}
            <span>{isLoading ? t('chat.toolRunning') : hasError ? t('chat.toolFailed') : t('chat.toolCompleted')}</span>
            {variant === 'full' && call.durationMs != null && (
              <span className="ml-auto tabular-nums">{(call.durationMs / 1000).toFixed(2)}s</span>
            )}
          </div>
          {/* Raw input/output JSON */}
          {call.input != null && (
            <div className="flex-shrink-0">
              <span className="text-xs font-medium text-fg-muted">{t('chat.toolInput')}</span>
              <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-surface-sunken p-2.5 text-[11px] text-fg-secondary">
                {formatJson(call.input)}
              </pre>
            </div>
          )}
          {output !== undefined && (
            <div className="flex min-h-0 flex-1 flex-col">
              <span className="text-xs font-medium text-fg-muted">{t('chat.toolOutput')}</span>
              <div className="mt-1 min-h-0 flex-1 overflow-auto rounded-md border border-edge bg-surface-sunken p-2.5 text-[11px] text-fg-secondary">
                <JsonDataView value={parseJsonValue(output)} />
              </div>
            </div>
          )}
        </div>
      </Drawer>
    </>
  );
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** A restrained tree view: keys line up, nested collections can be folded, and
 * long strings wrap without turning the drawer into an undifferentiated blob. */
function JsonDataView({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (Array.isArray(value)) {
    return (
      <div className="space-y-1">
        {value.map((item, index) => (
          <JsonCollectionRow key={index} label={String(index)} value={item} depth={depth} />
        ))}
      </div>
    );
  }

  if (value !== null && typeof value === 'object') {
    return (
      <div className="space-y-1">
        {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
          <JsonCollectionRow key={key} label={key} value={item} depth={depth} />
        ))}
      </div>
    );
  }

  return <JsonPrimitive value={value} />;
}

function JsonCollectionRow({ label, value, depth }: { label: string; value: unknown; depth: number }) {
  const t = useT();
  const nested = value !== null && typeof value === 'object';
  if (!nested) {
    return (
      <div className="grid grid-cols-[minmax(5rem,0.32fr)_minmax(0,1fr)] gap-2 border-b border-edge/50 py-1 last:border-b-0">
        <span className="break-words font-medium text-primary-fg">{label}</span>
        <JsonPrimitive value={value} />
      </div>
    );
  }

  const count = Array.isArray(value) ? value.length : Object.keys(value as Record<string, unknown>).length;
  return (
    <details open={depth < 1} className="group rounded border border-edge/60 bg-surface-raised/60">
      <summary className="flex cursor-pointer list-none items-center gap-1 px-2 py-1.5 text-fg-muted hover:text-fg-secondary">
        <ChevronRight size={11} className="flex-shrink-0 transition-transform group-open:rotate-90" />
        <span className="min-w-0 flex-1 break-words font-medium text-primary-fg">{label}</span>
        <span className="flex-shrink-0 text-[10px] text-fg-faint">
          {t(Array.isArray(value) ? 'tools.itemCount' : 'tools.fieldCount', { count })}
        </span>
      </summary>
      <div className="border-t border-edge/60 px-2 py-1.5">
        <JsonDataView value={value} depth={depth + 1} />
      </div>
    </details>
  );
}

function JsonPrimitive({ value }: { value: unknown }) {
  if (value === null) return <span className="font-mono text-fg-faint">null</span>;
  if (typeof value === 'boolean') return <span className="font-mono text-warning">{String(value)}</span>;
  if (typeof value === 'number') return <span className="font-mono text-info">{value}</span>;
  return <span className="whitespace-pre-wrap break-words font-mono text-fg-secondary">{String(value)}</span>;
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
