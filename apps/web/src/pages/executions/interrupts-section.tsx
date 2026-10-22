import type { RuntimeInterrupt } from '@greenhouse/types/runtime';
import { DetailSection } from '../../components/detail';
import { Card, Tag } from '../../components/ui';
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

/**
 * Read-only: no source domain has an interrupt decision driver since Workflows
 * (gates) and Missions (approvals) were retired in v1.4, so historical
 * interrupts are shown, never decided here.
 */
export function RuntimeInterruptsSection({ interrupts }: { interrupts: readonly RuntimeInterrupt[] }) {
  const t = useT();
  if (interrupts.length === 0) return null;
  return (
    <DetailSection title={t('taskCenter.interrupts')} className="mt-6">
      <div className="space-y-3">
        {interrupts.map((interrupt) => {
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
