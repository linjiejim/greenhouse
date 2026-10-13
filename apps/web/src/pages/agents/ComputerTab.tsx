/**
 * 电脑 (AGNT-18, AGNT-20): the Agent's own sandbox. Its state, start / stop / restart (files in
 * the home stay), and the background processes it runs. Watching and taking over come with the
 * computer view.
 */

import { Power, RotateCw, Square } from 'lucide-react';
import { Button, Empty, ErrorBox, Skeleton, StatusBadge, type Tone } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { ComputerJob, ComputerView } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useComputer, useComputerAction, useProcesses } from '../../data/agents';
import type { MessageKey } from '../../i18n/zh';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';

const STATE: Record<ComputerView['state'], { word: MessageKey; tone: Tone }> = {
  stopped: { word: 'computer.stopped', tone: 'neutral' },
  starting: { word: 'computer.starting', tone: 'info' },
  running: { word: 'computer.running', tone: 'info' },
  failed: { word: 'computer.failed', tone: 'danger' },
};

const JOB: Record<ComputerJob['status'], { word: MessageKey; tone: Tone }> = {
  running: { word: 'status.running', tone: 'info' },
  exited: { word: 'status.done', tone: 'success' },
  lost: { word: 'status.failed', tone: 'danger' },
};

export function ComputerTab({ agentId }: { agentId: string }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const computer = useComputer(agentId);
  const running = computer.data?.state === 'running';
  const processes = useProcesses(agentId, running);
  const action = useComputerAction(agentId);
  const run = (kind: 'start' | 'stop' | 'restart') =>
    action.mutate(kind, {
      onError: (caught) => notify(caught instanceof ApiClientError ? caught.message : t('common.error')),
    });

  if (computer.isPending) return <Skeleton lines={3} />;
  if (computer.isError) return <ErrorBox onRetry={() => void computer.refetch()}>{t('common.error')}</ErrorBox>;
  const view = computer.data;
  const state = STATE[view.state];

  return (
    <section className="app-section" aria-label={t('agents.tabComputer')}>
      <div className="app-setting-row">
        <div className="app-setting-text">
          <strong>
            {t('agents.tabComputer')} <StatusBadge status={t(state.word)} tone={state.tone} />
          </strong>
          <span>
            {view.state_reason ??
              (view.last_active_at
                ? t('computer.lastActive', {
                    time: relativeTime(view.last_active_at, { locale, timeZone: me.timezone }),
                  })
                : t('computer.never'))}
          </span>
        </div>
        <div className="app-inline-actions">
          {view.state === 'running' || view.state === 'starting' ? (
            <>
              <Button onClick={() => run('restart')} loading={action.isPending && action.variables === 'restart'}>
                <RotateCw size={icon.md} />
                {t('computer.restart')}
              </Button>
              <Button onClick={() => run('stop')} loading={action.isPending && action.variables === 'stop'}>
                <Square size={icon.sm} />
                {t('computer.stop')}
              </Button>
            </>
          ) : (
            <Button kind="primary" onClick={() => run('start')} loading={action.isPending}>
              <Power size={icon.md} />
              {t('computer.start')}
            </Button>
          )}
        </div>
      </div>

      <h2 className="app-section-title">{t('computer.processes')}</h2>
      {!running ? (
        <Empty title={t('computer.offlineProcesses')} />
      ) : processes.isPending ? (
        <Skeleton lines={2} />
      ) : !(processes.data?.items ?? []).length ? (
        <Empty title={t('computer.noProcesses')} />
      ) : (
        <ul className="app-list">
          {processes.data!.items.map((job) => {
            const status = JOB[job.status];
            return (
              <li key={job.id} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title">{job.name || job.command}</span>
                  <span className="app-list-meta app-mono">{job.command}</span>
                </span>
                {job.exit_code !== null && job.exit_code !== 0 && (
                  <span className="app-list-time">{t('computer.exitCode', { code: job.exit_code })}</span>
                )}
                <StatusBadge status={t(status.word)} tone={status.tone} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
