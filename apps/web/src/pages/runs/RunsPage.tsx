/**
 * Runs (RUN-01): what the Agents do in the background, from conversations, schedules and
 * automations. Running and finished lists filter by Agent; 定时 lists every schedule.
 */

import type { RunView } from '@greenhouse/contract';
import { useState } from 'react';
import { Activity, CalendarClock, Play } from 'lucide-react';
import { Button, Empty, ErrorBox, Select, Skeleton, StatusBadge, Switch } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { ApiClientError } from '@greenhouse/contract/client';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { useAgents } from '../../data/agents';
import { useRuns } from '../../data/runs';
import { useScheduleActions, useSchedules } from '../../data/schedules';
import { describeCron } from '../../lib/cron';
import { useI18n } from '../../lib/i18n';
import { href, type RunView as RunsView } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { AgentAvatar } from '../../shell/AgentAvatar';
import { Page, PageHeader } from '../../shell/Page';
import { RUN_SOURCE, RUN_STATUS } from './status';

function Schedules() {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const schedules = useSchedules();
  const agents = useAgents('mine');
  const actions = useScheduleActions();
  if (schedules.isPending) return <Skeleton lines={4} />;
  if (schedules.isError) return <ErrorBox onRetry={() => void schedules.refetch()}>{t('common.error')}</ErrorBox>;
  if (!schedules.items.length) return <Empty icon={<CalendarClock />} title={t('schedules.none')} />;
  return (
    <ul className="app-list">
      {schedules.items.map((schedule) => {
        const agent = agents.items.find((item) => item.id === schedule.agent_id);
        return (
          <li key={schedule.id} className="app-list-row is-static">
            {agent && <AgentAvatar agent={agent} size={24} />}
            <a
              className="app-list-main"
              href={href({ page: 'agent', id: agent?.is_main ? 'main' : schedule.agent_id, tab: 'schedules' })}
            >
              <span className="app-list-title">{schedule.name}</span>
              <span className="app-list-meta">
                {agent?.name ?? ''} · {describeCron(schedule.cron, locale)}
                {schedule.status === 'active' && schedule.next_run_at
                  ? ` · ${t('schedules.next', { time: relativeTime(schedule.next_run_at, { locale, timeZone: me.timezone }) })}`
                  : ''}
              </span>
            </a>
            <Button
              kind="ghost"
              size="sm"
              onClick={() =>
                actions.runNow.mutate(schedule.id, {
                  onSuccess: () => notify(t('schedules.started', { name: schedule.name })),
                  onError: (error) => notify(error instanceof ApiClientError ? error.message : t('common.error')),
                })
              }
            >
              <Play size={icon.sm} />
              {t('schedules.runNow')}
            </Button>
            <Switch
              label={t('runs.enableSchedule', { name: schedule.name })}
              checked={schedule.status === 'active'}
              onChange={(on) => (on ? actions.resume : actions.pause).mutate(schedule.id)}
            />
          </li>
        );
      })}
    </ul>
  );
}

function RunList({ view }: { view: 'active' | 'done' }) {
  const { t } = useI18n();
  const agents = useAgents('mine');
  const [agent, setAgent] = useState('');
  const runs = useRuns(view, agent || undefined);
  const filter = (
    <Select
      label={t('runs.byAgent')}
      value={agent}
      placeholder={t('runs.allAgents')}
      options={[
        { value: '', label: t('runs.allAgents') },
        ...agents.items.map((item) => ({ value: item.id, label: item.name })),
      ]}
      onChange={setAgent}
    />
  );
  let body;
  if (runs.isPending) body = <Skeleton lines={5} />;
  else if (runs.isError) body = <ErrorBox onRetry={() => void runs.refetch()}>{t('common.error')}</ErrorBox>;
  else if (!runs.items.length)
    body =
      view === 'active' ? (
        <RecentFinished items={runs.data?.recent_finished ?? []} />
      ) : (
        <Empty icon={<Activity />} title={t('runs.noneDone')} />
      );
  else body = <RunRows items={runs.items} />;
  return (
    <>
      <div className="app-toolbar">{filter}</div>
      {body}
    </>
  );
}

function RunRows({ items }: { items: RunView[] }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const agents = useAgents('mine');
  return (
    <ul className="app-list">
      {items.map((run) => {
        const owner = agents.items.find((item) => item.id === run.agent_id);
        const status = RUN_STATUS[run.status];
        const when = run.finished_at ?? run.started_at ?? run.created_at;
        return (
          <li key={run.id}>
            <a className="app-list-row" href={href({ page: 'run', id: run.id })}>
              {owner && <AgentAvatar agent={owner} size={24} />}
              <span className="app-list-main">
                <span className="app-list-title">{run.title}</span>
                <span className="app-list-meta">
                  {owner?.name ?? ''} · {t(RUN_SOURCE[run.source])}
                </span>
              </span>
              <StatusBadge status={t(status.word)} tone={status.tone} />
              <time className="app-list-time" dateTime={when}>
                {relativeTime(when, { locale, timeZone: me.timezone })}
              </time>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

function RecentFinished({ items }: { items: RunView[] }) {
  const { t } = useI18n();
  return (
    <>
      <Empty icon={<Activity />} title={t('runs.noneActive')} />
      <p>
        <a href={href({ page: 'runs', view: 'done' })}>{t('runs.viewFinished')}</a>
      </p>
      {items.length > 0 && (
        <>
          <p className="app-muted">{t('runs.recentFinished')}</p>
          <RunRows items={items} />
        </>
      )}
    </>
  );
}

export function RunsPage({ view }: { view: RunsView }) {
  const { t } = useI18n();
  return (
    <Page
      header={
        <PageHeader title={t(`runs.${view}`)} help={view === 'scheduled' ? t('runs.scheduledHelp') : t('runs.help')} />
      }
    >
      {view === 'scheduled' ? <Schedules /> : <RunList view={view === 'active' ? 'active' : 'done'} />}
    </Page>
  );
}
