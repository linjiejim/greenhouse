/**
 * Usage: model calls and tokens by member (/api/admin/usage/summary), by agent profile and by caller
 * (/api/profiles/usage/summary), over all time or the last 30 / 7 days / 24 hours; and module usage
 * (/api/admin/usage/modules?days=7|30|90): tool calls by tool × client, page opens by module ×
 * client and the prompt-cache hit rate per model. Counters hold totals only, no people or content.
 */
import React, { useCallback, useState } from 'react';
import { get } from '../api/client';
import { useResource } from '../data/use-resource';
import { useStationManifest } from '../plugins/store';
import { localize } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { useT, type TFunction, type TranslationKey } from '../lib/i18n';
import { Icon } from '../ui/core';
import { AdminPage, Badge, Bar, Card, Kpis, SectionState, Tabs } from './kit.web';
import { USAGE_PERIODS, formatDuration, formatTokens, periodSince, type UsagePeriod } from './format';
import {
  CORE_MODULES,
  USAGE_CLIENTS,
  USAGE_DAYS,
  formatRate,
  overallCacheHitRate,
  sumCounts,
  totalsByClient,
  totalsByKey,
  type KeyTotal,
  type ModuleUsageReport,
  type UsageDays,
  type UsageSummary,
  type UserUsage,
} from './usage-model';

type Tab = 'users' | 'profiles' | 'callers' | 'modules';

const clientLabel = (client: string, t: TFunction) =>
  (USAGE_CLIENTS as readonly string[]).includes(client) ? t(`admin.usage.client.${client}` as TranslationKey) : client;

export default function UsageSection() {
  const t = useT();
  const [tab, setTab] = useState<Tab>('users');
  const [period, setPeriod] = useState<UsagePeriod>('');
  const [days, setDays] = useState<UsageDays>(30);
  const [version, setVersion] = useState(0);
  const periodLabel = (p: UsagePeriod) =>
    t(
      p === ''
        ? 'admin.usage.allTime'
        : p === '30d'
          ? 'admin.usage.last30'
          : p === '7d'
            ? 'admin.usage.last7'
            : 'admin.usage.last24h',
    );
  return (
    <AdminPage
      title={t('admin.sections.usage')}
      testID="admin-usage"
      actions={
        <>
          {tab === 'modules' ? (
            <select
              className="gh-input"
              aria-label={t('admin.usage.range')}
              value={days}
              onChange={(e) => setDays(Number(e.target.value) as UsageDays)}
            >
              {USAGE_DAYS.map((d) => (
                <option key={d} value={d}>
                  {t('admin.usage.lastDays', { n: d })}
                </option>
              ))}
            </select>
          ) : (
            <select
              className="gh-input"
              aria-label={t('admin.usage.range')}
              value={period}
              onChange={(e) => setPeriod(e.target.value as UsagePeriod)}
            >
              {USAGE_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {periodLabel(p)}
                </option>
              ))}
            </select>
          )}
          <button className="gh-icon-button" aria-label={t('common.refresh')} onClick={() => setVersion((v) => v + 1)}>
            <Icon name="refresh" size={16} />
          </button>
        </>
      }
      tabs={
        <Tabs
          label={t('admin.sections.usage')}
          value={tab}
          onChange={setTab}
          items={[
            { value: 'users', label: t('admin.usage.byUsers') },
            { value: 'profiles', label: t('admin.usage.byProfiles') },
            { value: 'callers', label: t('admin.usage.byCallers') },
            { value: 'modules', label: t('admin.usage.byModules') },
          ]}
        />
      }
    >
      {tab === 'users' ? (
        <ByUsers key={`${period}:${version}`} period={period} />
      ) : tab === 'modules' ? (
        <ModuleUsage key={`${days}:${version}`} days={days} />
      ) : (
        <BySummary key={`${period}:${version}`} period={period} by={tab} />
      )}
    </AdminPage>
  );
}

function ByUsers({ period }: { period: UsagePeriod }) {
  const t = useT();
  const data = useResource(
    useCallback(
      () => get<{ by_user: UserUsage[] }>('/api/admin/usage/summary', { since: periodSince(period) }),
      [period],
    ),
  );
  const rows = data.data?.by_user;
  if (!rows?.length)
    return (
      <SectionState
        loading={data.loading}
        error={data.error}
        retry={() => void data.refresh()}
        icon="bar"
        title={t('admin.usage.noData')}
      />
    );
  const max = Math.max(...rows.map((r) => Number(r.total_calls)));
  const input = rows.reduce((s, r) => s + Number(r.total_input_tokens), 0);
  const output = rows.reduce((s, r) => s + Number(r.total_output_tokens), 0);
  return (
    <>
      <Kpis
        items={[
          { label: t('admin.usage.users'), value: String(rows.length) },
          {
            label: t('admin.usage.calls'),
            value: rows.reduce((s, r) => s + Number(r.total_calls), 0).toLocaleString(),
          },
          {
            label: t('admin.usage.tokens'),
            value: formatTokens(input + output),
            hint: t('admin.usage.inputOutput', { input: formatTokens(input), output: formatTokens(output) }),
          },
        ]}
      />
      <table className="gh-data-grid gh-admin-grid" data-testid="admin-usage-users">
        <thead>
          <tr>
            <th>{t('admin.usage.user')}</th>
            <th>{t('admin.users.role')}</th>
            <th className="gh-number">{t('admin.usage.calls')}</th>
            <th className="gh-number">{t('admin.usage.input')}</th>
            <th className="gh-number">{t('admin.usage.output')}</th>
            <th style={{ width: 180 }}>{t('admin.usage.share')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((u) => (
            <tr key={u.user_id}>
              <td>{u.nickname}</td>
              <td>
                <Badge tone={u.role === 'super' ? 'accent' : 'neutral'}>
                  {u.role === 'super'
                    ? t('admin.users.roleSuper')
                    : u.role === 'team'
                      ? t('admin.users.roleTeam')
                      : u.role}
                </Badge>
              </td>
              <td className="gh-number">{Number(u.total_calls).toLocaleString()}</td>
              <td className="gh-number">{formatTokens(Number(u.total_input_tokens))}</td>
              <td className="gh-number">{formatTokens(Number(u.total_output_tokens))}</td>
              <td>
                <Bar value={Number(u.total_calls)} max={max} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function BySummary({ period, by }: { period: UsagePeriod; by: 'profiles' | 'callers' }) {
  const t = useT();
  const data = useResource(
    useCallback(() => get<UsageSummary>('/api/profiles/usage/summary', { since: periodSince(period) }), [period]),
  );
  const summary = data.data;
  if (!summary) return <SectionState loading={data.loading} error={data.error} retry={() => void data.refresh()} />;
  const { total } = summary;
  const rows =
    by === 'profiles'
      ? summary.by_profile.map((p) => ({
          key: p.profile_id,
          calls: Number(p.calls),
          input: p.input_tokens,
          output: p.output_tokens,
          ms: p.avg_duration_ms,
        }))
      : summary.by_caller.map((c) => ({
          key: c.caller || t('admin.usage.unknown'),
          calls: Number(c.calls),
          input: c.input_tokens,
          output: c.output_tokens,
          ms: 0,
        }));
  const max = Math.max(0, ...rows.map((r) => r.calls));
  return (
    <>
      <Kpis
        items={[
          { label: t('admin.usage.calls'), value: Number(total.total_calls).toLocaleString() },
          {
            label: t('admin.usage.inputTokens'),
            value: formatTokens(Number(total.total_input_tokens)),
            hint: t('admin.usage.cached', { n: formatTokens(Number(total.total_cached_tokens)) }),
          },
          {
            label: t('admin.usage.outputTokens'),
            value: formatTokens(Number(total.total_output_tokens)),
            hint: t('admin.usage.reasoning', { n: formatTokens(Number(total.total_reasoning_tokens)) }),
          },
        ]}
      />
      {rows.length ? (
        <table className="gh-data-grid gh-admin-grid" data-testid={`admin-usage-${by}`}>
          <thead>
            <tr>
              <th>{by === 'profiles' ? t('admin.usage.profile') : t('admin.usage.caller')}</th>
              <th className="gh-number">{t('admin.usage.calls')}</th>
              <th className="gh-number">{t('admin.usage.input')}</th>
              <th className="gh-number">{t('admin.usage.output')}</th>
              {by === 'profiles' ? <th className="gh-number">{t('admin.usage.avgDuration')}</th> : null}
              <th style={{ width: 180 }}>{t('admin.usage.share')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className={by === 'profiles' ? 'gh-mono' : undefined}>{r.key}</td>
                <td className="gh-number">{r.calls.toLocaleString()}</td>
                <td className="gh-number">{formatTokens(Number(r.input))}</td>
                <td className="gh-number">{formatTokens(Number(r.output))}</td>
                {by === 'profiles' ? <td className="gh-number">{r.ms ? formatDuration(Number(r.ms)) : '—'}</td> : null}
                <td>
                  <Bar value={r.calls} max={max} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <SectionState icon="bar" title={t('admin.usage.noData')} />
      )}
    </>
  );
}

function ModuleUsage({ days }: { days: UsageDays }) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const manifest = useStationManifest((s) => s.data);
  const data = useResource(useCallback(() => get<ModuleUsageReport>('/api/admin/usage/modules', { days }), [days]));
  const report = data.data;
  const note = <p className="gh-hint">{t('admin.usage.sinceNote')}</p>;
  if (!report)
    return (
      <>
        {note}
        <SectionState loading={data.loading} error={data.error} retry={() => void data.refresh()} />
      </>
    );
  if (!report.tool_calls.length && !report.page_opens.length && !report.cache_by_model.length)
    return (
      <>
        {note}
        <SectionState icon="bar" title={t('admin.usage.modulesEmpty')} message={t('admin.usage.modulesEmptyHint')} />
      </>
    );
  const moduleLabel = (key: string) => {
    if (key.startsWith('ext.')) {
      const id = key.slice(4);
      const plugin = manifest.kind === 'v2' ? manifest.manifest.plugins.find((p) => p.id === id) : undefined;
      return plugin ? localize(plugin.name, lang) : id;
    }
    if ((CORE_MODULES as readonly string[]).includes(key)) return t(`admin.usage.module.${key}` as TranslationKey);
    const [area, rest] = key.split('.', 2);
    if ((area === 'admin' || area === 'settings') && rest)
      return `${area === 'admin' ? t('admin.title') : t('nav.settings')} › ${rest}`;
    return key;
  };
  const clients = totalsByClient(report.tool_calls, report.page_opens);
  return (
    <>
      {note}
      <Kpis
        items={[
          { label: t('admin.usage.toolCalls'), value: sumCounts(report.tool_calls).toLocaleString() },
          { label: t('admin.usage.pageOpens'), value: sumCounts(report.page_opens).toLocaleString() },
          {
            label: t('admin.usage.cacheHitRate'),
            value: formatRate(overallCacheHitRate(report.cache_by_model)),
            hint: t('admin.usage.cacheHitRateHint'),
          },
        ]}
      />
      {clients.length ? (
        <Card title={t('admin.usage.byClient')} icon="computer" flush>
          <table className="gh-data-grid gh-admin-grid">
            <thead>
              <tr>
                <th>{t('admin.usage.clientCol')}</th>
                <th className="gh-number">{t('admin.usage.toolCalls')}</th>
                <th className="gh-number">{t('admin.usage.pageOpens')}</th>
              </tr>
            </thead>
            <tbody>
              {clients.map((c) => (
                <tr key={c.client}>
                  <td>{clientLabel(c.client, t)}</td>
                  <td className="gh-number">{c.toolCalls.toLocaleString()}</td>
                  <td className="gh-number">{c.pageOpens.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : null}
      <div className="gh-admin-grid-2">
        <Card title={t('admin.usage.toolCallsByTool')} icon="wrench" flush>
          <KeyTotals
            rows={totalsByKey(report.tool_calls)}
            head={t('admin.usage.tool')}
            label={(k) => k}
            mono
            empty={t('admin.usage.noToolCalls')}
          />
        </Card>
        <Card title={t('admin.usage.pageOpensByModule')} icon="apps" flush>
          <KeyTotals
            rows={totalsByKey(report.page_opens)}
            head={t('admin.usage.module.title')}
            label={moduleLabel}
            empty={t('admin.usage.noPageOpens')}
          />
        </Card>
      </div>
      <Card title={t('admin.usage.cacheByModel')} icon="sparkle" flush>
        {report.cache_by_model.length ? (
          <table className="gh-data-grid gh-admin-grid">
            <thead>
              <tr>
                <th>{t('admin.metering.model')}</th>
                <th className="gh-number">{t('admin.usage.calls')}</th>
                <th className="gh-number">{t('admin.usage.input')}</th>
                <th className="gh-number">{t('admin.usage.cachedTokens')}</th>
                <th className="gh-number">{t('admin.usage.hitRate')}</th>
              </tr>
            </thead>
            <tbody>
              {report.cache_by_model.map((m) => (
                <tr key={m.model}>
                  <td className="gh-mono">{m.model}</td>
                  <td className="gh-number">{m.calls.toLocaleString()}</td>
                  <td className="gh-number">{formatTokens(m.input_tokens)}</td>
                  <td className="gh-number">{formatTokens(m.cached_tokens)}</td>
                  <td className="gh-number">{formatRate(m.hit_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="gh-admin-empty-line">{t('admin.usage.noModelCalls')}</p>
        )}
      </Card>
    </>
  );
}

function KeyTotals({
  rows,
  head,
  label,
  mono,
  empty,
}: {
  rows: KeyTotal[];
  head: string;
  label: (key: string) => string;
  mono?: boolean;
  empty: string;
}) {
  const t = useT();
  if (!rows.length) return <p className="gh-admin-empty-line">{empty}</p>;
  return (
    <table className="gh-data-grid gh-admin-grid">
      <thead>
        <tr>
          <th>{head}</th>
          <th>{t('admin.usage.clientCol')}</th>
          <th className="gh-number">{t('admin.usage.total')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td className={mono ? 'gh-mono' : undefined} title={row.key}>
              {label(row.key)}
            </td>
            <td>
              <span className="gh-chip-row">
                {row.clients.map((c) => (
                  <Badge key={c.client}>
                    {clientLabel(c.client, t)} {c.count.toLocaleString()}
                  </Badge>
                ))}
              </span>
            </td>
            <td className="gh-number">{row.total.toLocaleString()}</td>
          </tr>
        ))}
        <tr>
          <td colSpan={2}>
            <strong>{t('admin.usage.total')}</strong>
          </td>
          <td className="gh-number">
            <strong>{rows.reduce((s, r) => s + r.total, 0).toLocaleString()}</strong>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
