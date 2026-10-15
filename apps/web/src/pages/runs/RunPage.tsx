import { errorText } from '../../lib/errors';
import { ExtensionPanels } from '../../extensions/host';
import { Attachments } from '../../conversation/Attachments';
/**
 * A run's detail (RUN-02) opens as a drawer over its list: status, the brief, what needs the
 * member, the steps, the result and where it came from. Cancel while it runs; retry the failed
 * steps when it failed. It refreshes while active.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Button, ErrorBox, Overlay, OverlayActions, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { RunDetail } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQuery } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { Markdown } from '../../conversation/Markdown';
import { RequestCard } from '../../conversation/RequestCard';
import { useAgents } from '../../data/agents';
import { keys } from '../../data/query';
import { useRequests } from '../../data/requests';
import { useRunAction } from '../../data/runs';
import { api } from '../../lib/api';
import { cx } from '../../lib/cx';
import { useI18n } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { RunsPage } from './RunsPage';
import { isActive, RUN_SOURCE, RUN_STATUS } from './status';

const seconds = (ms: number) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 60_000)}m`);

function Detail({ run }: { run: RunDetail }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const agents = useAgents('mine');
  const requests = useRequests(run.conversation_id ?? undefined, 'all', true);
  const [brief, setBrief] = useState(false);
  const agent = agents.items.find((item) => item.id === run.agent_id);
  const status = RUN_STATUS[run.status];
  const mine = requests.items.filter((request) => request.run_id === run.id);
  const took =
    run.started_at && run.finished_at ? new Date(run.finished_at).getTime() - new Date(run.started_at).getTime() : null;

  return (
    <div className="app-run">
      <div className="app-run-meta">
        <StatusBadge status={t(status.word)} tone={status.tone} />
        <span>
          {agent?.name ?? ''} · {t(RUN_SOURCE[run.source])} ·{' '}
          {relativeTime(run.started_at ?? run.created_at, { locale, timeZone: me.timezone })}
          {took !== null && ` · ${t('runs.duration', { time: seconds(took) })}`}
          {run.attempt > 1 && ` · ${t('runs.attempt', { count: run.attempt })}`}
        </span>
      </div>
      {run.progress !== null && <p role="status">{t('media.progress', { count: run.progress })}</p>}
      <Attachments ids={run.file_ids} />
      {run.error && (
        <p className="app-run-error" role="alert">
          {run.error.message}
        </p>
      )}
      {mine.map((request) => (
        <RequestCard key={request.id} request={request} />
      ))}
      {run.output && (
        <section className="app-section">
          <h3 className="app-section-title">{t('runs.output')}</h3>
          <Markdown text={run.output} />
        </section>
      )}
      <section className="app-section">
        <h3 className="app-section-title">{t('runs.steps')}</h3>
        {run.steps.length ? (
          <ol className="app-steps is-run">
            {run.steps.map((step) => (
              <li key={step.id} className={cx('app-step', `is-${step.status}`)}>
                <span className="app-step-dot" aria-hidden />
                <span className="app-step-summary">
                  {step.summary}
                  {step.error && <span className="app-step-error"> · {step.error.message}</span>}
                </span>
                {/* It was running when its process died: it may have taken effect, and is never run again by itself. */}
                {step.status === 'uncertain' && <StatusBadge status={t('status.uncertain')} tone="warning" />}
                {step.duration_ms !== null && <span className="app-step-time">{seconds(step.duration_ms)}</span>}
              </li>
            ))}
          </ol>
        ) : (
          <p className="app-muted">{t('runs.noSteps')}</p>
        )}
      </section>
      {run.brief && (
        <section className="app-section">
          <button type="button" className="app-disclosure" aria-expanded={brief} onClick={() => setBrief(!brief)}>
            {brief ? <ChevronDown size={icon.sm} /> : <ChevronRight size={icon.sm} />}
            {t('runs.brief')}
          </button>
          {brief && <pre className="app-request-text">{run.brief}</pre>}
        </section>
      )}
    </div>
  );
}

export function RunPage({ id }: { id: string }) {
  const { t } = useI18n();
  const notify = useNotify();
  const action = useRunAction();
  const run = useQuery({
    queryKey: keys.run(id),
    queryFn: () => api.runs.get(id),
    refetchInterval: (query) => (query.state.data && isActive(query.state.data) ? 3_000 : false),
  });
  const list = run.data && !isActive(run.data) ? 'done' : 'active';
  const close = () => navigate({ page: 'runs', view: list }, { replace: true });
  const failed = (error: unknown) => notify(errorText(error, t));

  return (
    <>
      <RunsPage view={list} />
      <Overlay title={run.data?.title ?? t('nav.runs')} onClose={close}>
        {run.isPending ? (
          <Skeleton lines={5} />
        ) : run.isError || !run.data ? (
          <ErrorBox onRetry={() => void run.refetch()}>
            {run.error instanceof ApiClientError && run.error.status === 404 ? t('runs.notFound') : t('common.error')}
          </ErrorBox>
        ) : (
          <Detail run={run.data} />
        )}
        {run.data && <ExtensionPanels entity="run" id={run.data.id} />}
        {run.data && (
          <OverlayActions>
            {run.data.conversation_id && (
              <Button
                kind="ghost"
                className="app-actions-start"
                onClick={() => navigate({ page: 'conversation', id: run.data!.conversation_id! })}
              >
                {t('runs.openSource')}
              </Button>
            )}
            {isActive(run.data) && (
              <Button
                loading={action.isPending}
                onClick={() =>
                  action.mutate(
                    { id, action: 'cancel' },
                    { onSuccess: () => notify(t('runs.canceled')), onError: failed },
                  )
                }
              >
                {t('runs.cancel')}
              </Button>
            )}
            {run.data.status === 'failed' && (
              <Button
                kind="primary"
                loading={action.isPending}
                onClick={() =>
                  action.mutate(
                    { id, action: 'retry' },
                    { onSuccess: () => notify(t('runs.retried')), onError: failed },
                  )
                }
              >
                {t('runs.retry')}
              </Button>
            )}
          </OverlayActions>
        )}
      </Overlay>
    </>
  );
}
