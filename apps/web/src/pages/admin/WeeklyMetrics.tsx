import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ErrorBox, Select, Skeleton } from '@greenhouse/ui/kit';
import type { WeeklyMetric } from '@greenhouse/contract';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

const fields = [
  ['adopted_per_active_member', 'adopted', false],
  ['activation_rate', 'activation', true],
  ['decision_latency_minutes', 'latency', false],
  ['background_success_rate', 'success', true],
  ['cards_per_active_member_day', 'cards', false],
  ['approval_rate', 'approval', true],
  ['tier3_share', 'tier3', true],
  ['cache_hit_rate', 'cache', true],
  ['event_wakeups', 'wakes', false],
] as const;

export function WeeklyMetrics() {
  const { t, locale } = useI18n();
  const [week, setWeek] = useState('');
  const query = useQuery({ queryKey: ['weekly-metrics'], queryFn: () => api.metrics.weekly(), staleTime: 30000 });
  const rows = query.data?.weeks ?? [];
  const selected = rows.find((row) => row.week_start === week) ?? rows[0];
  const value = (row: WeeklyMetric, key: (typeof fields)[number][0], percent: boolean) => {
    const n = row[key];
    return n === null
      ? '—'
      : percent
        ? new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 }).format(n)
        : n.toLocaleString(locale, { maximumFractionDigits: 1 });
  };
  return (
    <section className="app-section" aria-label={t('metrics.title')}>
      <h3 className="app-section-title">{t('metrics.title')}</h3>
      {query.isPending ? (
        <Skeleton lines={3} />
      ) : query.isError ? (
        <ErrorBox onRetry={() => void query.refetch()}>{t('common.error')}</ErrorBox>
      ) : (
        selected && (
          <>
            <Select
              label={t('metrics.week')}
              value={selected.week_start}
              options={rows.map((row) => ({
                value: row.week_start,
                label: `${row.week_start.slice(0, 10)} – ${row.week_end.slice(0, 10)}`,
              }))}
              onChange={setWeek}
            />
            <p className="app-muted">
              {t('metrics.sample', {
                active: selected.active_members,
                outputs: selected.adopted_outputs,
                joined: selected.new_members,
                activated: selected.activated_members,
              })}
            </p>
            <dl className="app-stats-grid">
              {fields.map(([key, label, percent]) => (
                <div className="app-stat" key={key}>
                  <dt className="app-stat-label">{t(`metrics.${label}`)}</dt>
                  <dd className="app-stat-value">{value(selected, key, percent)}</dd>
                </div>
              ))}
            </dl>
            <p className="app-muted">{t('metrics.hint')}</p>
          </>
        )
      )}
    </section>
  );
}
