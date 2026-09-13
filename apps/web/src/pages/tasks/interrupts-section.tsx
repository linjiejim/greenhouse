import type { RuntimeInterrupt, RuntimeUserAction } from '@greenhouse/types/runtime';
import { DetailSection } from '../../components/detail';
import { Button, Card, Tag } from '../../components/ui';
import { Check, X } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';
import { RuntimePayloadPanel } from './payload-panel';
import { RuntimeRiskTag } from './status-axes';

const INTERRUPT_KEYS: Record<RuntimeInterrupt['kind'], TranslationKey> = {
  mutation_approval: 'taskCenter.interrupt.mutationApproval',
  workflow_gate: 'taskCenter.interrupt.workflowGate',
  ask_user: 'taskCenter.interrupt.askUser',
  credential_required: 'taskCenter.interrupt.credentialRequired',
  budget_exceeded: 'taskCenter.interrupt.budgetExceeded',
  external_dependency: 'taskCenter.interrupt.externalDependency',
  outcome_unknown: 'taskCenter.interrupt.outcomeUnknown',
  manual_pause: 'taskCenter.interrupt.manualPause',
};

export function RuntimeInterruptsSection({
  interrupts,
  actions,
  busyId,
  onDecision,
}: {
  interrupts: readonly RuntimeInterrupt[];
  actions: readonly RuntimeUserAction[];
  busyId: string | null;
  onDecision: (interrupt: RuntimeInterrupt, decision: 'approve' | 'reject') => void;
}) {
  const t = useT();
  if (interrupts.length === 0) return null;
  const canApprove = actions.includes('approve');
  const canReject = actions.includes('reject');
  return (
    <DetailSection title={t('taskCenter.interrupts')} className="mt-6">
      <div className="space-y-3">
        {interrupts.map((interrupt) => {
          const decisionSupported =
            interrupt.status === 'pending' &&
            (interrupt.kind === 'mutation_approval' || interrupt.kind === 'workflow_gate');
          return (
            <Card key={interrupt.id} className="p-3 sm:p-4">
              <div className="flex flex-wrap items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Tag tone={interrupt.status === 'pending' ? 'warning' : 'neutral'}>
                      {t(`taskCenter.interruptStatus.${interrupt.status}`)}
                    </Tag>
                    <RuntimeRiskTag risk={interrupt.risk_level} />
                    <h3 className="text-sm font-semibold text-fg">{t(INTERRUPT_KEYS[interrupt.kind])}</h3>
                  </div>
                  <p className="mt-1 text-[10px] text-fg-faint">
                    {t('taskCenter.requestedAt', { time: formatDate(interrupt.created_at) })}
                  </p>
                </div>
                {decisionSupported && (canApprove || canReject) && (
                  <div className="flex flex-wrap gap-2">
                    {canReject && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === interrupt.id}
                        onClick={() => onDecision(interrupt, 'reject')}
                      >
                        <X size={13} className="mr-1" aria-hidden="true" />
                        {t('taskCenter.reject')}
                      </Button>
                    )}
                    {canApprove && (
                      <Button
                        size="sm"
                        disabled={busyId === interrupt.id}
                        onClick={() => onDecision(interrupt, 'approve')}
                      >
                        <Check size={13} className="mr-1" aria-hidden="true" />
                        {t('taskCenter.approve')}
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-3 space-y-2">
                <RuntimePayloadPanel title={t('taskCenter.requestPayload')} value={interrupt.payload} open />
                <RuntimePayloadPanel title={t('taskCenter.decisionPayload')} value={interrupt.decision} />
              </div>
              {interrupt.canonical_input_hash && (
                <p className="selectable mt-2 break-all font-mono text-[10px] text-fg-faint">
                  {t('taskCenter.inputHash')}: {interrupt.canonical_input_hash}
                </p>
              )}
            </Card>
          );
        })}
      </div>
    </DetailSection>
  );
}
