/**
 * Node inspector — everything needed to debug one node without leaving the run.
 *
 * Four sections: the delegation contract (brief), the blackboard references
 * RESOLVED to their actual values (the thing you actually want when a node
 * misbehaves), the structured output with its check verdicts, and runtime
 * metadata. Trace still opens the node's own session for the full transcript.
 */

import React from 'react';
import type { WorkflowNode, WorkflowNodeRunView } from '@greenhouse/types/workflow';
import { useT } from '../../lib/i18n';

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-fg-faint">{title}</div>
      {children}
    </div>
  );
}

function Json({ value }: { value: unknown }) {
  return (
    <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-raised px-2 py-1.5 text-[10px] leading-relaxed text-fg-secondary">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-1.5 text-[10px]">
      <span className="flex-shrink-0 text-fg-faint">{label}</span>
      <span className="min-w-0 break-words text-fg-secondary">{value}</span>
    </div>
  );
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

export function WorkflowInspector({
  node,
  row,
  attempts,
  isDeliverable,
  onOpenSession,
  actions,
}: {
  node: WorkflowNode;
  row: WorkflowNodeRunView | undefined;
  attempts: WorkflowNodeRunView[];
  isDeliverable: boolean;
  onOpenSession?: (sessionId: string) => void;
  actions?: React.ReactNode;
}) {
  const t = useT();
  const checks = row?.checks_result as { reviewer?: string; feedback?: string; gate_note?: string } | null | undefined;

  return (
    <div className="space-y-2.5 rounded-md border border-edge bg-surface-sunken px-2.5 py-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs font-semibold text-fg">{node.id}</span>
        <span className="rounded bg-surface-muted px-1 py-px text-[9px] text-fg-faint">{node.agent}</span>
        {isDeliverable && (
          <span className="rounded bg-primary-subtle px-1 py-px text-[9px] text-primary-fg-strong">
            {t('workflow.deliverable')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          {actions}
          {row?.session_id && onOpenSession && (
            <button
              onClick={() => onOpenSession(row.session_id!)}
              className="rounded-md border border-edge px-1.5 py-0.5 text-[10px] text-fg-secondary transition-colors hover:bg-surface-muted hover:text-fg"
            >
              {t('workflow.trace')} →
            </button>
          )}
        </div>
      </div>

      <Section title={t('workflow.inspectBrief')}>
        <div className="space-y-1">
          <div className="text-[11px] leading-relaxed text-fg">{node.brief.objective}</div>
          {node.brief.end_on && <Field label={t('workflow.briefEndOn')} value={node.brief.end_on} />}
          {node.brief.boundaries && <Field label={t('workflow.briefBoundaries')} value={node.brief.boundaries} />}
          {node.role_addendum && <Field label={t('workflow.briefAddendum')} value={node.role_addendum} />}
          {node.brief.output_schema && (
            <Field
              label={t('workflow.briefSchema')}
              value={Object.entries(node.brief.output_schema)
                .map(([k, v]) => `${k}: ${v}`)
                .join(' · ')}
            />
          )}
          {(node.depends_on?.length ?? 0) > 0 && (
            <Field label={t('workflow.briefDepends')} value={node.depends_on!.join(', ')} />
          )}
        </div>
      </Section>

      <Section title={t('workflow.inspectInputs')}>
        {row?.inputs && Object.keys(row.inputs).length > 0 ? (
          <Json value={row.inputs} />
        ) : (
          <div className="text-[10px] text-fg-faint">{t('workflow.inspectNoInputs')}</div>
        )}
      </Section>

      <Section title={t('workflow.inspectOutputs')}>
        {row?.outputs ? (
          <Json value={row.outputs} />
        ) : (
          <div className="text-[10px] text-fg-faint">{t('workflow.inspectNoOutputs')}</div>
        )}
        {checks?.reviewer && (
          <div className={`mt-1 text-[10px] ${checks.reviewer === 'pass' ? 'text-success' : 'text-warning'}`}>
            {t('workflow.inspectReviewer')}: {checks.reviewer}
            {checks.feedback ? ` — ${checks.feedback}` : ''}
          </div>
        )}
        {row?.error && <div className="mt-1 text-[10px] text-danger">{row.error}</div>}
      </Section>

      <Section title={t('workflow.inspectMeta')}>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5">
          <Field label={t('workflow.metaStatus')} value={row?.status ?? t('workflow.metaNotStarted')} />
          <Field label={t('workflow.metaAttempt')} value={`${row?.attempt ?? 0} / ${attempts.length}`} />
          {row?.tokens != null && <Field label={t('workflow.metaTokens')} value={row.tokens.toLocaleString()} />}
          {row?.duration_ms != null && (
            <Field label={t('workflow.metaDuration')} value={formatDuration(row.duration_ms)} />
          )}
        </div>
      </Section>
    </div>
  );
}
