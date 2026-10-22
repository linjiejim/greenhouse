/**
 * Shared pieces of Settings › Agent connections: tags for risk / status /
 * basis, the operation label, and the collapsible JSON block. Text always
 * carries the meaning; tone only reinforces it.
 */

import React, { useState } from 'react';
import type { AgentWriteBasis, AgentWriteRisk, AgentWriteStatus, AgentWriteView } from '@greenhouse/types/agent-access';
import { Tag } from '../../../components/ui';
import type { TagTone } from '../../../lib/utils';
import { ChevronDown, ChevronRight } from '../../../lib/icons';
import { useT } from '../../../lib/i18n';
import type { TranslationKey } from '../../../lib/i18n';

const RISK_TONE: Record<AgentWriteRisk, TagTone> = { r1: 'neutral', r2: 'warning', r3: 'danger' };

const STATUS_TONE: Record<AgentWriteStatus, TagTone> = {
  pending: 'info',
  running: 'info',
  executed: 'success',
  failed: 'danger',
  rejected: 'neutral',
  expired: 'neutral',
  withdrawn: 'neutral',
  superseded: 'neutral',
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

export function useStatusLabel() {
  const t = useT();
  return (status: AgentWriteStatus) => t(`agentAccess.status_${status}` as TranslationKey);
}

export function BasisLabel({ basis }: { basis: AgentWriteBasis | null }) {
  const t = useT();
  if (!basis) return <span className="text-fg-faint">—</span>;
  return <span className="text-xs text-fg-secondary">{t(`agentAccess.basis_${basis}` as TranslationKey)}</span>;
}

/** `tables_mutation · records.update` — the tool and the action the agent asked for. */
export function OperationLabel({ view }: { view: Pick<AgentWriteView, 'tool_id' | 'action'> }) {
  return (
    <span className="font-mono text-xs text-fg-secondary break-all">
      {view.tool_id}
      {view.action ? <span className="text-fg"> · {view.action}</span> : null}
    </span>
  );
}

export function JsonBlock({ value, maxHeight = 'max-h-64' }: { value: unknown; maxHeight?: string }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
  return (
    <pre
      className={`text-[11px] leading-relaxed font-mono bg-surface-sunken text-fg-secondary rounded-lg p-2.5 overflow-auto whitespace-pre-wrap break-all ${maxHeight}`}
    >
      {text}
    </pre>
  );
}

export function Collapsible({
  openLabel,
  closedLabel,
  defaultOpen = false,
  children,
}: {
  openLabel: string;
  closedLabel: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-fg transition-colors"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {open ? openLabel : closedLabel}
      </button>
      {open && <div className="mt-2">{children}</div>}
    </div>
  );
}
