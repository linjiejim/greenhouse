import type { RuntimeInterrupt, RuntimeRun } from '@greenhouse/types/runtime';
import { Card, EmptyState, Tag } from '../../components/ui';
import { AlertTriangle, CheckCircle2, ListTodo } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { formatDate } from '../../lib/utils';
import { executionRunHref, runtimeRunProjection, runtimeRunSubtitle, runtimeRunTitle } from './model';
import type { RuntimeConnectionState } from './model';
import { RuntimeKindTag, RuntimeStatusAxes } from './status-axes';

export function TaskRunList({
  runs,
  interrupts,
  connection = 'connected',
}: {
  runs: readonly RuntimeRun[];
  interrupts: readonly RuntimeInterrupt[];
  connection?: RuntimeConnectionState;
}) {
  const t = useT();
  if (runs.length === 0) {
    return (
      <EmptyState icon={ListTodo} title={t('taskCenter.emptyTitle')} description={t('taskCenter.emptyDescription')} />
    );
  }

  return (
    <div className="space-y-2" role="list">
      {runs.map((run) => {
        const title = runtimeRunTitle(run);
        const subtitle = runtimeRunSubtitle(run);
        const projection = runtimeRunProjection(run, interrupts, Date.now(), connection);
        return (
          <Card key={run.id} className="group transition-colors hover:bg-surface-muted" role="listitem">
            <a
              href={executionRunHref(run)}
              className="flex min-h-20 items-start gap-3 px-3 py-3 sm:items-center sm:px-4"
              aria-label={t('taskCenter.openRun', { title })}
            >
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <RuntimeKindTag kind={run.kind} />
                  <span className="min-w-0 flex-1 truncate text-sm font-semibold text-fg" title={title}>
                    {title}
                  </span>
                  <span className="text-[10px] text-fg-faint">{formatDate(run.created_at)}</span>
                </div>
                {subtitle && (
                  <p className="mt-1 line-clamp-1 text-xs text-fg-muted" title={subtitle}>
                    {subtitle}
                  </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <RuntimeStatusAxes projection={projection} compact />
                  {run.attempt > 1 && <Tag tone="warning">{t('taskCenter.attempt', { count: run.attempt })}</Tag>}
                  {run.error_code && (
                    <Tag
                      tone="danger"
                      icon={<AlertTriangle size={10} aria-hidden="true" />}
                      title={run.error_message ?? undefined}
                    >
                      {run.error_code}
                    </Tag>
                  )}
                  {run.status === 'succeeded' && run.settled_at && (
                    <Tag tone="success" icon={<CheckCircle2 size={10} aria-hidden="true" />}>
                      {t('taskCenter.settled')}
                    </Tag>
                  )}
                </div>
              </div>
            </a>
          </Card>
        );
      })}
    </div>
  );
}
