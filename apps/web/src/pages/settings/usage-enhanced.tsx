/**
 * Enhanced Usage Panel — unified LLM Usage Dashboard with sub-tabs:
 * By Users, By Profiles, By Caller.
 */

import { useState, useEffect } from 'react';
import { Card, Spinner, SkeletonCard, Tag } from '../../components/ui';
import { Users, Bot, Wrench, type LucideIcon } from '../../lib/icons';
import { fetchUsageSummary, fetchUserUsageSummary, formatTokens, formatDuration, estimateCost } from '../../lib/api';
import type { UsageSummary, UserUsageSummary } from '../../lib/api';
import { ROLE_TONE, type TagTone } from '../../lib/utils';
import {
  PERIODS,
  periodToSince,
  CALLER_COLORS,
  PROFILE_COLORS,
  KpiCard,
  DistributionBar,
} from '../../components/usage/usage-widgets';

const CALLER_TONE: Record<string, TagTone> = {
  chat: 'info',
  compiler: 'info',
  judge: 'warning',
};

// ─── Sub-tab Definitions ─────────────────────────────────

type SubTab = 'users' | 'profiles' | 'callers';

const SUB_TABS: Array<{ key: SubTab; label: string; icon: LucideIcon }> = [
  { key: 'users', label: 'By Users', icon: Users },
  { key: 'profiles', label: 'By Profiles', icon: Bot },
  { key: 'callers', label: 'By Callers', icon: Wrench },
];

// ─── By Users Tab ────────────────────────────────────────

function ByUsersTab({ period }: { period: string }) {
  const [data, setData] = useState<UserUsageSummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const since = periodToSince(period);
    fetchUserUsageSummary(since)
      .then((d) => {
        setData(d.by_user);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period]);

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <SkeletonCard />
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (data.length === 0) {
    return <div className="text-sm text-fg-faint text-center py-8">No usage data</div>;
  }

  const maxCalls = Math.max(...data.map((d) => Number(d.total_calls)));
  const totalCalls = data.reduce((s, d) => s + Number(d.total_calls), 0);
  const totalInput = data.reduce((s, d) => s + Number(d.total_input_tokens), 0);
  const totalOutput = data.reduce((s, d) => s + Number(d.total_output_tokens), 0);
  const totalCost = estimateCost({ inputTokens: totalInput, outputTokens: totalOutput });

  return (
    <div className="space-y-4">
      {/* KPI summary */}
      <div className="grid grid-cols-4 gap-4">
        <KpiCard title="Total Users">
          <div className="text-2xl font-bold text-fg">{data.length}</div>
        </KpiCard>
        <KpiCard title="Total Calls">
          <div className="text-2xl font-bold text-fg">{totalCalls.toLocaleString()}</div>
        </KpiCard>
        <KpiCard title="Total Tokens">
          <div className="text-2xl font-bold text-fg">{formatTokens(totalInput + totalOutput)}</div>
          <div className="text-[11px] text-fg-faint mt-0.5">
            In: {formatTokens(totalInput)} / Out: {formatTokens(totalOutput)}
          </div>
        </KpiCard>
        <KpiCard title="Estimated Cost">
          <div className="text-2xl font-bold text-fg">${totalCost.usd.toFixed(4)}</div>
          <div className="text-[11px] text-fg-faint mt-0.5">¥{totalCost.cny.toFixed(4)}</div>
        </KpiCard>
      </div>

      {/* Detail table */}
      <Card className="p-0 overflow-hidden">
        <table className="w-full text-[11px]">
          <thead>
            <tr className="text-fg-faint border-b border-edge bg-surface-sunken/50">
              <th className="text-left font-medium py-2.5 px-4">User</th>
              <th className="text-left font-medium py-2.5 px-3">Role</th>
              <th className="text-right font-medium py-2.5 px-3">Calls</th>
              <th className="text-right font-medium py-2.5 px-3">Input</th>
              <th className="text-right font-medium py-2.5 px-3">Output</th>
              <th className="text-right font-medium py-2.5 px-3">Est. Cost</th>
              <th className="text-left font-medium py-2.5 px-3 w-32">Distribution</th>
            </tr>
          </thead>
          <tbody>
            {data.map((u) => {
              const cost = estimateCost({
                inputTokens: Number(u.total_input_tokens),
                outputTokens: Number(u.total_output_tokens),
              });
              const barWidth = maxCalls > 0 ? (Number(u.total_calls) / maxCalls) * 100 : 0;
              return (
                <tr key={u.user_id} className="text-fg-secondary border-b border-edge hover:bg-surface-sunken">
                  <td className="py-2 px-4">
                    <span className="font-medium text-fg">{u.nickname}</span>
                  </td>
                  <td className="py-2 px-3">
                    <Tag tone={ROLE_TONE[u.role] ?? 'neutral'} className="capitalize">
                      {u.role}
                    </Tag>
                  </td>
                  <td className="py-2 px-3 text-right font-mono">{Number(u.total_calls).toLocaleString()}</td>
                  <td className="py-2 px-3 text-right">{formatTokens(Number(u.total_input_tokens))}</td>
                  <td className="py-2 px-3 text-right">{formatTokens(Number(u.total_output_tokens))}</td>
                  <td className="py-2 px-3 text-right font-mono">${cost.usd.toFixed(3)}</td>
                  <td className="py-2 px-3">
                    <div className="w-full bg-surface-muted rounded-full h-2 overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary-400"
                        style={{ width: `${Math.max(barWidth, 2)}%` }}
                      />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// ─── By Profiles Tab ─────────────────────────────────────

function ByProfilesTab({ summary }: { summary: UsageSummary }) {
  const { by_profile, total } = summary;
  const totalCost = estimateCost({
    inputTokens: Number(total.total_input_tokens),
    outputTokens: Number(total.total_output_tokens),
    cachedTokens: Number(total.total_cached_tokens),
  });

  return (
    <div className="space-y-4">
      {/* KPI summary */}
      <div className="grid grid-cols-4 gap-4">
        <KpiCard title="Total Calls">
          <div className="text-2xl font-bold text-fg">{Number(total.total_calls).toLocaleString()}</div>
        </KpiCard>
        <KpiCard title="Input Tokens">
          <div className="text-2xl font-bold text-fg">{formatTokens(total.total_input_tokens)}</div>
          {Number(total.total_cached_tokens) > 0 && (
            <div className="text-[11px] text-fg-faint mt-0.5">{formatTokens(total.total_cached_tokens)} cached</div>
          )}
        </KpiCard>
        <KpiCard title="Output Tokens">
          <div className="text-2xl font-bold text-fg">{formatTokens(total.total_output_tokens)}</div>
          {Number(total.total_reasoning_tokens) > 0 && (
            <div className="text-[11px] text-fg-faint mt-0.5">
              {formatTokens(total.total_reasoning_tokens)} reasoning
            </div>
          )}
        </KpiCard>
        <KpiCard title="Estimated Cost">
          <div className="text-2xl font-bold text-fg">${totalCost.usd.toFixed(4)}</div>
          <div className="text-[11px] text-fg-faint mt-0.5">¥{totalCost.cny.toFixed(4)}</div>
        </KpiCard>
      </div>

      {/* Distribution + detail */}
      <Card className="p-4">
        <div className="text-xs font-semibold text-fg-muted mb-3">Profile Distribution</div>
        <DistributionBar
          items={by_profile.map((p, i) => ({
            label: p.profile_id,
            value: Number(p.calls),
            color: PROFILE_COLORS[i % PROFILE_COLORS.length],
          }))}
        />
        {by_profile.length > 0 && (
          <div className="mt-4 pt-4 border-t border-edge">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-fg-faint">
                  <th className="text-left font-medium pb-2">Profile</th>
                  <th className="text-right font-medium pb-2">Calls</th>
                  <th className="text-right font-medium pb-2">Input</th>
                  <th className="text-right font-medium pb-2">Output</th>
                  <th className="text-right font-medium pb-2">Avg Duration</th>
                  <th className="text-right font-medium pb-2">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {by_profile.map((p) => {
                  const cost = estimateCost({
                    inputTokens: Number(p.input_tokens),
                    outputTokens: Number(p.output_tokens),
                  });
                  return (
                    <tr key={p.profile_id} className="text-fg-secondary border-b border-edge last:border-0">
                      <td className="py-1.5 font-mono font-medium text-fg">{p.profile_id}</td>
                      <td className="py-1.5 text-right">{Number(p.calls).toLocaleString()}</td>
                      <td className="py-1.5 text-right">{formatTokens(p.input_tokens)}</td>
                      <td className="py-1.5 text-right">{formatTokens(p.output_tokens)}</td>
                      <td className="py-1.5 text-right">
                        {p.avg_duration_ms ? formatDuration(p.avg_duration_ms) : '—'}
                      </td>
                      <td className="py-1.5 text-right font-mono">${cost.usd.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── By Callers Tab ──────────────────────────────────────

function ByCallersTab({ summary }: { summary: UsageSummary }) {
  const { by_caller, total } = summary;
  const totalCost = estimateCost({
    inputTokens: Number(total.total_input_tokens),
    outputTokens: Number(total.total_output_tokens),
    cachedTokens: Number(total.total_cached_tokens),
  });

  return (
    <div className="space-y-4">
      {/* KPI summary */}
      <div className="grid grid-cols-4 gap-4">
        <KpiCard title="Total Calls">
          <div className="text-2xl font-bold text-fg">{Number(total.total_calls).toLocaleString()}</div>
        </KpiCard>
        <KpiCard title="Input Tokens">
          <div className="text-2xl font-bold text-fg">{formatTokens(total.total_input_tokens)}</div>
          {Number(total.total_cached_tokens) > 0 && (
            <div className="text-[11px] text-fg-faint mt-0.5">{formatTokens(total.total_cached_tokens)} cached</div>
          )}
        </KpiCard>
        <KpiCard title="Output Tokens">
          <div className="text-2xl font-bold text-fg">{formatTokens(total.total_output_tokens)}</div>
          {Number(total.total_reasoning_tokens) > 0 && (
            <div className="text-[11px] text-fg-faint mt-0.5">
              {formatTokens(total.total_reasoning_tokens)} reasoning
            </div>
          )}
        </KpiCard>
        <KpiCard title="Estimated Cost">
          <div className="text-2xl font-bold text-fg">${totalCost.usd.toFixed(4)}</div>
          <div className="text-[11px] text-fg-faint mt-0.5">¥{totalCost.cny.toFixed(4)}</div>
        </KpiCard>
      </div>

      {/* Distribution + detail */}
      <Card className="p-4">
        <div className="text-xs font-semibold text-fg-muted mb-3">Caller Distribution</div>
        <DistributionBar
          items={by_caller.map((c) => ({
            label: c.caller || '(unknown)',
            value: Number(c.calls),
            color: CALLER_COLORS[c.caller] || 'bg-fg-faint',
          }))}
        />
        {by_caller.length > 0 && (
          <div className="mt-4 pt-4 border-t border-edge">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-fg-faint">
                  <th className="text-left font-medium pb-2">Caller</th>
                  <th className="text-right font-medium pb-2">Calls</th>
                  <th className="text-right font-medium pb-2">Input</th>
                  <th className="text-right font-medium pb-2">Output</th>
                  <th className="text-right font-medium pb-2">Est. Cost</th>
                </tr>
              </thead>
              <tbody>
                {by_caller.map((c) => {
                  const cost = estimateCost({
                    inputTokens: Number(c.input_tokens),
                    outputTokens: Number(c.output_tokens),
                  });
                  return (
                    <tr key={c.caller} className="text-fg-secondary border-b border-edge last:border-0">
                      <td className="py-1.5">
                        <Tag tone={CALLER_TONE[c.caller] ?? 'neutral'}>{c.caller || '(unknown)'}</Tag>
                      </td>
                      <td className="py-1.5 text-right">{Number(c.calls).toLocaleString()}</td>
                      <td className="py-1.5 text-right">{formatTokens(c.input_tokens)}</td>
                      <td className="py-1.5 text-right">{formatTokens(c.output_tokens)}</td>
                      <td className="py-1.5 text-right font-mono">${cost.usd.toFixed(3)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ─── Combined Component (LLM Usage Dashboard) ────────────

export function UsagePanelWithUsers() {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [period, setPeriod] = useState('');
  const [activeTab, setActiveTab] = useState<SubTab>('users');

  useEffect(() => {
    setLoading(true);
    const since = periodToSince(period);
    fetchUsageSummary(since)
      .then((data) => {
        setSummary(data);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [period]);

  return (
    <div className="space-y-6">
      {/* Toolbar: Period Selector + Sub-tabs */}
      <div className="flex items-center justify-between">
        <div className="flex gap-1 border-b border-edge">
          {SUB_TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2 text-sm border-b-2 transition-colors ${
                  isActive
                    ? 'border-primary-500 text-primary-fg-strong font-medium'
                    : 'border-transparent text-fg-muted hover:text-fg-secondary hover:border-edge-strong'
                }`}
              >
                <Icon size={14} className={isActive ? 'text-primary-fg' : 'text-fg-faint'} />
                {tab.label}
              </button>
            );
          })}
        </div>
        <div className="flex gap-1 bg-surface-muted p-0.5 rounded-lg">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`px-3 py-1 text-xs rounded-md transition-colors ${
                period === p.value
                  ? 'bg-surface-raised text-primary-fg-strong font-medium shadow-sm'
                  : 'text-fg-muted hover:text-fg-secondary'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {loading && !summary ? (
        <div className="flex justify-center py-20">
          <Spinner className="text-primary-500" />
        </div>
      ) : !summary && activeTab !== 'users' ? (
        <div className="text-center py-20 text-fg-faint">Failed to load usage data</div>
      ) : (
        <>
          {activeTab === 'users' && <ByUsersTab period={period} />}
          {activeTab === 'profiles' && summary && <ByProfilesTab summary={summary} />}
          {activeTab === 'callers' && summary && <ByCallersTab summary={summary} />}
        </>
      )}
    </div>
  );
}
