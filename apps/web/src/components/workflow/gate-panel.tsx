/**
 * Human gate approval panel — rendered wherever a run is shown (card or dock).
 *
 * Escalation gates offer retry/skip/abort; the budget gate offers raise/abort;
 * before/after gates are a plain approve/reject with an optional note that is
 * fed back to the node as feedback.
 */

import React, { useCallback, useState } from 'react';
import type { WorkflowRunView } from '@greenhouse/types/workflow';
import { toast } from '../ui';
import { useT } from '../../lib/i18n';
import * as api from '../../lib/api';

export function GatePanel({
  runId,
  gate,
  onDecided,
}: {
  runId: string;
  gate: WorkflowRunView['gates'][number];
  onDecided: () => void;
}) {
  const t = useT();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const isEscalation = gate.kind === 'escalation';
  const isBudget = isEscalation && gate.payload.reason === 'budget_exceeded';

  const decide = useCallback(
    async (status: 'approved' | 'rejected', fixedNote?: string) => {
      setBusy(true);
      try {
        await api.decideWorkflowGate(runId, gate.id, status, fixedNote ?? (note.trim() || undefined));
        onDecided();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'failed', 'error');
      } finally {
        setBusy(false);
      }
    },
    [runId, gate.id, note, onDecided],
  );

  const kindLabel: Record<string, string> = {
    before_node: t('workflow.gateBefore'),
    after_node: t('workflow.gateAfter'),
    escalation: isBudget ? t('workflow.gateBudget') : t('workflow.gateEscalation'),
  };

  return (
    <div className="rounded-md border border-warning/40 bg-warning-subtle/40 px-2.5 py-2">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-fg">
        <span>⏸</span>
        <span>{kindLabel[gate.kind] ?? gate.kind}</span>
        {gate.node_id && (
          <span className="rounded bg-surface-muted px-1 py-px text-[9px] text-fg-faint">{gate.node_id}</span>
        )}
      </div>
      {'feedback' in gate.payload && typeof gate.payload.feedback === 'string' && (
        <div className="mb-1.5 text-[10px] text-fg-muted">{gate.payload.feedback}</div>
      )}
      {'error' in gate.payload && typeof gate.payload.error === 'string' && (
        <div className="mb-1.5 text-[10px] text-danger">{gate.payload.error}</div>
      )}
      {gate.kind === 'after_node' && gate.payload.outputs != null && (
        <pre className="mb-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-raised px-2 py-1.5 text-[10px] text-fg-secondary">
          {JSON.stringify(gate.payload.outputs, null, 2)}
        </pre>
      )}
      <div className="flex items-center gap-1.5">
        {isEscalation && !isBudget ? (
          <>
            <GateButton
              label={t('workflow.retry')}
              onClick={() => decide('approved', 'retry')}
              disabled={busy}
              primary
            />
            <GateButton label={t('workflow.skip')} onClick={() => decide('approved', 'skip')} disabled={busy} />
            <GateButton
              label={t('workflow.abort')}
              onClick={() => decide('rejected', note.trim() || undefined)}
              disabled={busy}
              danger
            />
          </>
        ) : (
          <>
            <GateButton
              label={isBudget ? t('workflow.raiseBudget') : t('workflow.approve')}
              onClick={() => decide('approved')}
              disabled={busy}
              primary
            />
            <GateButton
              label={isBudget ? t('workflow.abort') : t('workflow.reject')}
              onClick={() => decide('rejected')}
              disabled={busy}
              danger
            />
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('workflow.notePlaceholder')}
              className="min-w-0 flex-1 rounded-md border border-edge bg-surface-raised px-2 py-1 text-[10px] text-fg focus:border-primary-500 focus:outline-none"
            />
          </>
        )}
      </div>
    </div>
  );
}

export function GateButton({
  label,
  onClick,
  disabled,
  primary,
  danger,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  primary?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`flex-shrink-0 rounded-md px-2 py-1 text-[10px] font-medium transition-colors disabled:opacity-50 ${
        primary
          ? 'bg-primary-500 text-white hover:bg-primary-600'
          : danger
            ? 'border border-danger/40 text-danger hover:bg-danger-subtle'
            : 'border border-edge text-fg-secondary hover:bg-surface-muted'
      }`}
    >
      {label}
    </button>
  );
}
