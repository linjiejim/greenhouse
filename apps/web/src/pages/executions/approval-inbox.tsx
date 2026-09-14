import type { RuntimeInterruptKind } from '@greenhouse/types/runtime';
import type { RuntimeInterruptListItem } from '../../lib/api/runtime';
import { Button, Card, EmptyState } from '../../components/ui';
import { CheckCircle2, ChevronRight, Inbox } from '../../lib/icons';
import { useT, type TranslationKey } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';
import { executionRunHref, runtimeRunTitle } from './model';
import { RuntimeKindTag, RuntimeRiskTag } from './status-axes';

const INTERRUPT_KEYS: Record<RuntimeInterruptKind, TranslationKey> = {
  mutation_approval: 'taskCenter.interrupt.mutationApproval',
  workflow_gate: 'taskCenter.interrupt.workflowGate',
  ask_user: 'taskCenter.interrupt.askUser',
  credential_required: 'taskCenter.interrupt.credentialRequired',
  budget_exceeded: 'taskCenter.interrupt.budgetExceeded',
  external_dependency: 'taskCenter.interrupt.externalDependency',
  outcome_unknown: 'taskCenter.interrupt.outcomeUnknown',
  manual_pause: 'taskCenter.interrupt.manualPause',
};

export function ApprovalInbox({
  items,
  unavailable,
}: {
  items: readonly RuntimeInterruptListItem[];
  unavailable?: string;
}) {
  const t = useT();
  if (unavailable) {
    return (
      <EmptyState icon={Inbox} tone="danger" title={t('taskCenter.inboxUnavailableTitle')} description={unavailable} />
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState
        icon={CheckCircle2}
        tone="success"
        title={t('taskCenter.inboxEmptyTitle')}
        description={t('taskCenter.inboxEmptyDescription')}
      />
    );
  }

  return (
    <div className="space-y-2" aria-label={t('taskCenter.inboxTitle')}>
      {items.map((item) => {
        const title = runtimeRunTitle(item.run);
        return (
          <Card key={item.interrupt.id} className="p-3 sm:p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-lg bg-warning-subtle p-2 text-warning">
                <Inbox size={16} aria-hidden="true" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <RuntimeKindTag kind={item.run.kind} />
                  <RuntimeRiskTag risk={item.interrupt.risk_level} />
                  <span className="text-xs font-semibold text-fg-secondary">
                    {t(INTERRUPT_KEYS[item.interrupt.kind])}
                  </span>
                </div>
                <h3 className="mt-1 truncate text-sm font-semibold text-fg" title={title}>
                  {title}
                </h3>
                <p className="mt-1 text-[10px] text-fg-faint">
                  {t('taskCenter.requestedAt', { time: formatDate(item.interrupt.created_at) })}
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  window.location.hash = executionRunHref(item.run);
                }}
              >
                <span className="hidden sm:inline">{t('taskCenter.review')}</span>
                <ChevronRight size={14} className="sm:ml-1" aria-hidden="true" />
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}
