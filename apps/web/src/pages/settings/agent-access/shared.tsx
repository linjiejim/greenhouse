/**
 * Shared pieces of Settings › Agent connections › Activity: tags for risk /
 * status / basis, the operation label, the target, and the input fields. Text
 * always carries the meaning; tone only reinforces it.
 */

import React from 'react';
import type { AgentWriteBasis, AgentWriteRisk, AgentWriteStatus, AgentWriteView } from '@greenhouse/types/agent-access';
import { Tag } from '../../../components/ui';
import type { TagTone } from '../../../lib/utils';
import { useT } from '../../../lib/i18n';
import type { TranslationKey } from '../../../lib/i18n';

// Shared-data writes are ordinary now; only a delete stands out.
const RISK_TONE: Record<AgentWriteRisk, TagTone> = { r1: 'neutral', r2: 'info', r3: 'danger' };

const STATUS_TONE: Record<AgentWriteStatus, TagTone> = {
  running: 'info',
  executed: 'success',
  failed: 'danger',
  outcome_unknown: 'warning',
};

export function RiskTag({ risk }: { risk: AgentWriteRisk }) {
  const t = useT();
  return <Tag tone={RISK_TONE[risk]}>{t(`agentAccess.risk_${risk}` as TranslationKey)}</Tag>;
}

export function StatusTag({ status }: { status: AgentWriteStatus }) {
  const t = useT();
  return <Tag tone={STATUS_TONE[status]}>{t(`agentAccess.status_${status}` as TranslationKey)}</Tag>;
}

export function BasisLabel({ basis }: { basis: AgentWriteBasis | null }) {
  const t = useT();
  if (!basis) return <span className="text-fg-faint">—</span>;
  return <span className="text-xs text-fg-secondary">{t(`agentAccess.basis_${basis}` as TranslationKey)}</span>;
}

/** `tables_mutation · records.update` — the tool and the action the agent asked for. */
export function OperationLabel({ view }: { view: Pick<AgentWriteView, 'tool_id' | 'action'> }) {
  return (
    <span className="font-mono text-xs text-fg-secondary break-words">
      {view.tool_id}
      {view.action ? <span className="text-fg"> · {view.action}</span> : null}
    </span>
  );
}

export function JsonBlock({ value, maxHeight = 'max-h-64' }: { value: unknown; maxHeight?: string }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <pre
      className={`text-caption leading-relaxed font-mono bg-surface-sunken text-fg-secondary rounded-md p-2.5 overflow-auto whitespace-pre-wrap break-all ${maxHeight}`}
    >
      {text}
    </pre>
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** What the write is about, for the card header: a title, name or record id when the input names one. */
export function writeTarget(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) return null;
  for (const key of ['title', 'name', 'doc_id', 'record_id', 'task_id', 'project_id', 'id']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  const ids = record.record_ids;
  if (Array.isArray(ids) && ids.length > 0) return ids.length === 1 ? String(ids[0]) : `${ids.length} records`;
  return null;
}

/**
 * A write's input as labeled fields: strings keep their line breaks (a doc body
 * reads as text, not as one escaped JSON line); nested values stay JSON.
 */
export function InputFields({ value }: { value: unknown }) {
  const record = asRecord(value);
  if (!record) return <JsonBlock value={value} />;
  const entries = Object.entries(record).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return (
    <dl className="rounded-md bg-surface-sunken p-2.5 space-y-1.5 text-caption leading-relaxed">
      {entries.map(([key, v]) => (
        <div key={key} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-2">
          <dt className="font-mono text-fg-faint truncate" title={key}>
            {key}
          </dt>
          <dd className="min-w-0 text-fg-secondary">
            {typeof v === 'string' ? (
              <span className="whitespace-pre-wrap break-words">{v}</span>
            ) : typeof v === 'number' || typeof v === 'boolean' ? (
              <span className="font-mono">{String(v)}</span>
            ) : (
              <pre className="font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">
                {JSON.stringify(v, null, 2)}
              </pre>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
