/**
 * Mission — run event timeline.
 *
 * Renders the step-level events replayed from agent_run_events. Payloads are
 * runner-authored JSON strings — every access goes through safeParse and
 * shape checks; a malformed payload degrades to a generic row, never a crash.
 *
 * tool.started/tool.completed pairs collapse into one expandable row;
 * run.heartbeat is never rendered. Only the FIRST run.started renders — the
 * runner used to emit one per provider-retry (fixed 2026-08-03), so replayed
 * timelines of older runs still carry the duplicates.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Markdown } from '../markdown';
import { Bot, CheckCircle2, ChevronDown, FileText, Play, Wrench, XCircle } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { formatDate, safeParse } from '../../lib/utils';
import { formatFileSize } from '../../lib/file-download';
import type { CloudAgentEvent } from '../../lib/api/cloud-agent';

type SystemTone = 'info' | 'success' | 'danger' | 'warning' | 'muted';

type TimelineItem =
  | { kind: 'system'; seq: number; ts: string; tone: SystemTone; label: string; detail?: string }
  | { kind: 'message'; seq: number; ts: string; text: string; model?: string }
  | {
      kind: 'tool';
      seq: number;
      ts: string;
      tool: string;
      state: 'running' | 'ok' | 'error';
      args?: unknown;
      result?: unknown;
    }
  | {
      kind: 'artifact';
      seq: number;
      ts: string;
      path: string;
      bytes?: number;
      error?: string;
      skipped?: boolean;
      recovered?: boolean;
    };

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v ? v : undefined;
}

interface TimelineLabels {
  started: string;
  completed: string;
  failed: string;
  canceled: string;
  artifactFailed: string;
  approvalRequested: string;
}

function buildTimeline(events: CloudAgentEvent[], labels: TimelineLabels): TimelineItem[] {
  const items: TimelineItem[] = [];
  // Open tool.started rows per tool name, awaiting their tool.completed.
  const openTools = new Map<string, Array<Extract<TimelineItem, { kind: 'tool' }>>>();
  let sawRunStarted = false;

  for (const ev of events) {
    const payload = safeParse<Record<string, unknown>>(ev.payload, {});
    switch (ev.type) {
      case 'run.heartbeat':
        break;
      case 'run.started':
        if (!sawRunStarted) {
          sawRunStarted = true;
          items.push({ kind: 'system', seq: ev.seq, ts: ev.created_at, tone: 'info', label: labels.started });
        }
        break;
      case 'message.assistant': {
        const text = asString(payload.text);
        if (text) items.push({ kind: 'message', seq: ev.seq, ts: ev.created_at, text, model: asString(payload.model) });
        break;
      }
      case 'tool.started': {
        const tool = asString(payload.tool) ?? 'tool';
        const item: Extract<TimelineItem, { kind: 'tool' }> = {
          kind: 'tool',
          seq: ev.seq,
          ts: ev.created_at,
          tool,
          state: 'running',
          args: payload.args,
        };
        items.push(item);
        const stack = openTools.get(tool) ?? [];
        stack.push(item);
        openTools.set(tool, stack);
        break;
      }
      case 'tool.completed': {
        const tool = asString(payload.tool) ?? 'tool';
        const open = openTools.get(tool)?.shift();
        if (open) {
          open.state = payload.is_error === true ? 'error' : 'ok';
          open.ts = ev.created_at;
          open.result = payload.result;
        } else {
          // Completion without a visible start (e.g. truncated start payload).
          items.push({
            kind: 'tool',
            seq: ev.seq,
            ts: ev.created_at,
            tool,
            state: payload.is_error === true ? 'error' : 'ok',
            result: payload.result,
          });
        }
        break;
      }
      case 'tool.approval_requested':
        items.push({
          kind: 'system',
          seq: ev.seq,
          ts: ev.created_at,
          tone: 'warning',
          label: labels.approvalRequested,
          detail: [asString(payload.tool), asString(payload.action)].filter(Boolean).join(' · ') || undefined,
        });
        break;
      // `artifact.failed` is a deliverable the agent wrote but the api never
      // received; `artifact.skipped` is one the collector declined to send
      // (stale timestamp, per-run ceiling, unreadable). Both share the artifact
      // row instead of falling through to the generic unknown-event marker —
      // these rows are the user's only clue that a file is missing from an
      // otherwise successful run. `recovered` marks a file the control plane's
      // terminal sweep picked up after the runner was gone.
      case 'artifact.created':
      case 'artifact.failed':
      case 'artifact.skipped':
        items.push({
          kind: 'artifact',
          seq: ev.seq,
          ts: ev.created_at,
          path: asString(payload.path) ?? 'artifact',
          bytes: typeof payload.bytes === 'number' ? payload.bytes : undefined,
          error: asString(payload.error) ?? (ev.type === 'artifact.failed' ? labels.artifactFailed : undefined),
          skipped: ev.type === 'artifact.skipped' || payload.skipped === true,
          recovered: payload.recovered === true,
        });
        break;
      case 'run.completed':
        items.push({ kind: 'system', seq: ev.seq, ts: ev.created_at, tone: 'success', label: labels.completed });
        break;
      case 'run.failed':
        items.push({
          kind: 'system',
          seq: ev.seq,
          ts: ev.created_at,
          tone: 'danger',
          label: labels.failed,
          detail: asString(payload.error),
        });
        break;
      case 'run.canceled':
        items.push({ kind: 'system', seq: ev.seq, ts: ev.created_at, tone: 'muted', label: labels.canceled });
        break;
      default:
        // Unknown event types render as a neutral marker instead of vanishing.
        items.push({ kind: 'system', seq: ev.seq, ts: ev.created_at, tone: 'muted', label: ev.type });
        break;
    }
  }
  return items;
}

function payloadText(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

/** Keep today's event clock compact; older events retain their calendar date. */
export function formatTimelineTime(dateStr: string, now = new Date()): string {
  const date = new Date(dateStr);
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return formatDate(dateStr);
}

/** Args keys worth surfacing on the collapsed row, most specific first. */
const ARG_HINT_KEYS = ['command', 'path', 'file_path', 'query', 'url', 'pattern', 'action'] as const;

/**
 * One-line hint pulled from the tool args (a bash command, a file path…) so a
 * collapsed timeline reads as WHAT each step did, not just which tool ran.
 * Runner payloads carry args as a JSON string — parse defensively, never throw.
 */
function argsHint(args: unknown): string | undefined {
  const obj = typeof args === 'string' ? safeParse<Record<string, unknown>>(args, {}) : args;
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of ARG_HINT_KEYS) {
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

const SYSTEM_TONE_CLS: Record<SystemTone, string> = {
  info: 'text-info',
  success: 'text-success',
  danger: 'text-danger',
  warning: 'text-warning',
  muted: 'text-fg-faint',
};

function StepNumber({ index }: { index?: number }) {
  if (index === undefined) return null;
  return (
    <span
      className="w-5 flex-shrink-0 text-right font-mono text-[10px] tabular-nums text-fg-faint"
      data-step-number={index}
    >
      {String(index).padStart(2, '0')}
    </span>
  );
}

function SystemRow({
  item,
  index,
  compact,
}: {
  item: Extract<TimelineItem, { kind: 'system' }>;
  index?: number;
  compact?: boolean;
}) {
  const Icon = item.tone === 'success' ? CheckCircle2 : item.tone === 'danger' ? XCircle : Play;
  return (
    <div className={`flex gap-2 px-1 ${compact ? 'min-h-7 items-center py-0.5' : 'items-start py-0.5'}`}>
      <StepNumber index={index} />
      <Icon size={14} className={`${compact ? '' : 'mt-0.5'} flex-shrink-0 ${SYSTEM_TONE_CLS[item.tone]}`} />
      <div className="min-w-0 flex-1">
        <span className={`text-xs font-medium ${SYSTEM_TONE_CLS[item.tone]}`}>{item.label}</span>
        {item.detail && (
          <div className="mt-0.5 whitespace-pre-wrap break-words text-xs text-fg-muted">{item.detail}</div>
        )}
      </div>
      <span className="flex-shrink-0 text-[10px] leading-none tabular-nums text-fg-faint">
        {formatTimelineTime(item.ts)}
      </span>
    </div>
  );
}

function MessageRow({ item }: { item: Extract<TimelineItem, { kind: 'message' }> }) {
  return (
    <div className="rounded-lg border border-edge bg-surface-card px-3 py-2">
      <div className="mb-1 flex items-center gap-1.5">
        <Bot size={13} className="flex-shrink-0 text-primary-fg" />
        {item.model && <span className="text-[10px] text-fg-faint">{item.model}</span>}
        <span className="ml-auto flex-shrink-0 text-[10px] text-fg-faint">{formatDate(item.ts)}</span>
      </div>
      <Markdown content={item.text} compact />
    </div>
  );
}

function ToolRow({
  item,
  showDetails = true,
  index,
  compact,
}: {
  item: Extract<TimelineItem, { kind: 'tool' }>;
  showDetails?: boolean;
  index?: number;
  compact?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const hasDetails = showDetails && (item.args !== undefined || item.result !== undefined);
  const hint = argsHint(item.args);
  const iconTone = item.state === 'error' ? 'text-danger' : item.state === 'ok' ? 'text-success' : 'text-info';
  return (
    <div className={compact ? '' : 'rounded-md border border-edge bg-surface-card'}>
      <button
        type="button"
        onClick={() => hasDetails && setOpen((v) => !v)}
        className={`flex w-full items-center gap-2 text-left ${compact ? 'min-h-7 px-1 py-0.5' : 'rounded-md px-3 py-1.5'} ${hasDetails ? 'cursor-pointer hover:bg-surface-muted' : 'cursor-default'} transition-colors`}
        title={formatDate(item.ts)}
        aria-expanded={hasDetails ? open : undefined}
      >
        <StepNumber index={index} />
        <Wrench size={13} className={`flex-shrink-0 ${iconTone}`} />
        <span className="flex-shrink-0 text-xs font-medium text-fg-secondary" title={item.tool}>
          {item.tool}
        </span>
        {hint ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-fg-faint" title={hint}>
            {hint}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <span className="flex-shrink-0 text-[10px] leading-none tabular-nums text-fg-faint">
          {formatTimelineTime(item.ts)}
        </span>
        {hasDetails && (
          <ChevronDown
            size={13}
            className={`flex-shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`}
          />
        )}
      </button>
      {open && hasDetails && (
        <div className="space-y-2 border-t border-edge px-3 py-2">
          {item.args !== undefined && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
                {t('cloudAgent.toolArgs')}
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-surface-sunken px-2.5 py-1.5 text-[11px] leading-relaxed text-fg-secondary">
                {payloadText(item.args)}
              </pre>
            </div>
          )}
          {item.result !== undefined && (
            <div>
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
                {t('cloudAgent.toolResult')}
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-surface-sunken px-2.5 py-1.5 text-[11px] leading-relaxed text-fg-secondary">
                {payloadText(item.result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ArtifactRow({
  item,
  index,
  compact,
}: {
  item: Extract<TimelineItem, { kind: 'artifact' }>;
  index?: number;
  compact?: boolean;
}) {
  const t = useT();
  const iconTone = item.error ? 'text-danger' : item.skipped ? 'text-fg-faint' : 'text-success';
  return (
    <div
      className={`flex items-center gap-2 ${compact ? 'min-h-7 px-1 py-0.5' : 'rounded-md border border-edge bg-surface-card px-3 py-1.5'}`}
    >
      <StepNumber index={index} />
      <FileText size={13} className={`flex-shrink-0 ${iconTone}`} />
      <span className="text-[10px] font-medium uppercase tracking-wide text-fg-faint">
        {t('cloudAgent.eventArtifact')}
      </span>
      <span className="min-w-0 truncate text-xs text-fg-secondary" title={item.path}>
        {item.path}
      </span>
      {item.error ? (
        <span className="flex-shrink-0 text-[10px] text-danger" title={item.error}>
          {t('common.failed')}
        </span>
      ) : item.skipped ? (
        <span className="flex-shrink-0 text-[10px] text-fg-faint">{t('cloudAgent.artifactSkipped')}</span>
      ) : item.bytes !== undefined ? (
        <span className="flex-shrink-0 text-[10px] text-fg-faint">{formatFileSize(item.bytes)}</span>
      ) : null}
      {item.recovered ? (
        <span className="flex-shrink-0 text-[10px] text-fg-faint">{t('cloudAgent.artifactRecovered')}</span>
      ) : null}
      <span className="ml-auto flex-shrink-0 text-[10px] tabular-nums text-fg-faint">
        {formatTimelineTime(item.ts)}
      </span>
    </div>
  );
}

export function RunTimeline({
  events,
  variant = 'detail',
}: {
  events: CloudAgentEvent[];
  /** Dock summaries show bounded progress only; outputs stay in the Chat flow. */
  variant?: 'detail' | 'summary';
}) {
  const t = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const items = useMemo(
    () =>
      buildTimeline(events, {
        started: t('cloudAgent.eventRunStarted'),
        completed: t('cloudAgent.eventRunCompleted'),
        failed: t('cloudAgent.eventRunFailed'),
        canceled: t('cloudAgent.eventRunCanceled'),
        artifactFailed: t('cloudAgent.eventArtifactFailed'),
        approvalRequested: t('cloudAgent.eventApprovalRequested'),
      }),
    [events, t],
  );
  const visibleItems = variant === 'summary' ? items.filter((item) => item.kind !== 'message') : items;

  useEffect(() => {
    if (variant !== 'summary' || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [events.length, variant, visibleItems.length]);

  return (
    <div
      ref={scrollRef}
      className={variant === 'summary' ? 'max-h-52 overflow-y-auto divide-y divide-edge/60' : 'space-y-2'}
      data-timeline-scroll={variant === 'summary' ? 'bottom' : undefined}
    >
      {visibleItems.map((item, itemIndex) => {
        const index = variant === 'summary' ? itemIndex + 1 : undefined;
        switch (item.kind) {
          case 'system':
            return <SystemRow key={item.seq} item={item} index={index} compact={variant === 'summary'} />;
          case 'message':
            return <MessageRow key={item.seq} item={item} />;
          case 'tool':
            return (
              <ToolRow
                key={item.seq}
                item={item}
                index={index}
                compact={variant === 'summary'}
                showDetails={variant === 'detail'}
              />
            );
          case 'artifact':
            return <ArtifactRow key={item.seq} item={item} index={index} compact={variant === 'summary'} />;
        }
      })}
    </div>
  );
}
