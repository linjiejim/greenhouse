/**
 * 用量与活动 (AGNT-15): how much the Agent was used and how it went — replies, background runs,
 * people, tokens, cost, 👍/👎 with recent comments — and its latest runs. Other people's
 * conversations show only status and times.
 */

import { ThumbsDown, ThumbsUp } from 'lucide-react';
import { Empty, ErrorBox, Skeleton, StatusBadge } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import { useQuery } from '@tanstack/react-query';
import { useMe } from '../../app/session';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';
import { href } from '../../lib/router';
import { relativeTime } from '../../lib/time';
import { formatCost, formatTokens, VoiceUsage } from '../../shell/usage';
import { RUN_STATUS } from '../runs/status';

export function ActivityTab({ agentId }: { agentId: string }) {
  const { t, locale } = useI18n();
  const me = useMe();
  const usage = useQuery({ queryKey: ['agents', 'usage', agentId], queryFn: () => api.usage.agent(agentId, 'month') });
  const activity = useQuery({
    queryKey: ['agents', 'activity', agentId],
    queryFn: () => api.usage.agentActivity(agentId, { limit: 30 }),
  });
  if (usage.isPending) return <Skeleton lines={5} />;
  const data = usage.data;
  return (
    <section className="app-section" aria-label={t('agents.tabActivity')}>
      {usage.isError && <ErrorBox onRetry={() => void usage.refetch()}>{t('common.error')}</ErrorBox>}
      {data && (
        <>
          <div className="app-stats-grid">
            <div className="app-stat">
              <span className="app-stat-label">{t('activity.replies')}</span>
              <span className="app-stat-value">{data.turns.total.toLocaleString(locale)}</span>
              {data.turns.failed > 0 && (
                <span className="app-stat-hint">{t('activity.failed', { count: data.turns.failed })}</span>
              )}
            </div>
            <div className="app-stat">
              <span className="app-stat-label">{t('activity.runs')}</span>
              <span className="app-stat-value">{data.background_runs.total.toLocaleString(locale)}</span>
            </div>
            <div className="app-stat">
              <span className="app-stat-label">{t('activity.people')}</span>
              <span className="app-stat-value">{data.people.toLocaleString(locale)}</span>
            </div>
            <div className="app-stat">
              <span className="app-stat-label">{t('usage.tokens')}</span>
              <span className="app-stat-value">{formatTokens(data.totals.tokens, locale)}</span>
              <span className="app-stat-hint">{formatCost(data.totals.cost_micros, locale)}</span>
            </div>
            <VoiceUsage totals={data.totals} />
          </div>
          <div className="app-ratings">
            <span>
              <ThumbsUp size={icon.sm} /> {data.ratings.up}
            </span>
            <span>
              <ThumbsDown size={icon.sm} /> {data.ratings.down}
            </span>
          </div>
          {data.ratings.comments.length > 0 && (
            <ul className="app-list">
              {data.ratings.comments.map((comment, index) => (
                <li key={index} className="app-list-row is-static">
                  {comment.rating > 0 ? <ThumbsUp size={icon.sm} /> : <ThumbsDown size={icon.sm} />}
                  <span className="app-list-main">
                    <span className="app-list-title">{comment.comment}</span>
                  </span>
                  <time className="app-list-time" dateTime={comment.created_at}>
                    {relativeTime(comment.created_at, { locale, timeZone: me.timezone })}
                  </time>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <h2 className="app-section-title">{t('activity.latest')}</h2>
      {activity.isPending ? (
        <Skeleton lines={4} />
      ) : activity.isError ? (
        <ErrorBox onRetry={() => void activity.refetch()}>{t('common.error')}</ErrorBox>
      ) : !(activity.data?.items ?? []).length ? (
        <Empty title={t('activity.none')} />
      ) : (
        <ul className="app-list">
          {activity.data!.items.map((item) => {
            const status = RUN_STATUS[item.status as keyof typeof RUN_STATUS];
            const when = item.finished_at ?? item.started_at ?? item.created_at;
            const target =
              item.kind === 'background'
                ? href({ page: 'run', id: item.id })
                : item.mine && item.conversation_id
                  ? href({ page: 'conversation', id: item.conversation_id })
                  : undefined;
            const body = (
              <>
                <span className="app-list-main">
                  <span className="app-list-title">
                    {item.mine ? item.title || t('activity.reply') : t('activity.someoneElse')}
                  </span>
                  <span className="app-list-meta">
                    {item.kind === 'background' ? t('activity.background') : t('activity.reply')}
                  </span>
                </span>
                {status && <StatusBadge status={t(status.word)} tone={status.tone} />}
                <time className="app-list-time" dateTime={when}>
                  {relativeTime(when, { locale, timeZone: me.timezone })}
                </time>
              </>
            );
            return (
              <li key={item.id}>
                {target ? (
                  <a className="app-list-row" href={target}>
                    {body}
                  </a>
                ) : (
                  <div className="app-list-row is-static">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
