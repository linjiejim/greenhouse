/**
 * Super-only Agent/Runtime operating panel.
 *
 * Token metrics are usage facts. USD is rendered only from settled/expired
 * usd_micros ledger deltas; this component never applies a blended token rate.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Card, Select, Spinner, Tag, type TagTone } from '../ui';
import { Bot, Coins, DollarSign, Gauge, RefreshCw, Users, type LucideIcon } from '../../lib/icons';
import { fetchCostValueReport, formatDuration, formatTokens, type CostValueReport } from '../../lib/api';
import { useT, type TranslationKey } from '../../lib/i18n';

type Period = 'month' | '7d' | '30d';

const RUNTIME_KIND_KEYS: Record<string, TranslationKey> = {
  chat: 'agents.costValue.runtimeKind.chat',
  automation: 'agents.costValue.runtimeKind.automation',
  workflow: 'agents.costValue.runtimeKind.workflow',
  mission: 'agents.costValue.runtimeKind.mission',
  subagent: 'agents.costValue.runtimeKind.subagent',
  eval: 'agents.costValue.runtimeKind.eval',
};

const RUNTIME_STATUS_KEYS: Record<string, TranslationKey> = {
  queued: 'agents.costValue.runtimeStatus.queued',
  claimed: 'agents.costValue.runtimeStatus.claimed',
  running: 'agents.costValue.runtimeStatus.running',
  waiting: 'agents.costValue.runtimeStatus.waiting',
  paused: 'agents.costValue.runtimeStatus.paused',
  succeeded: 'agents.costValue.runtimeStatus.succeeded',
  failed: 'agents.costValue.runtimeStatus.failed',
  canceled: 'agents.costValue.runtimeStatus.canceled',
  interrupted: 'agents.costValue.runtimeStatus.interrupted',
};

const STATUS_TONE: Record<string, TagTone> = {
  queued: 'neutral',
  claimed: 'info',
  running: 'info',
  waiting: 'warning',
  paused: 'warning',
  succeeded: 'success',
  failed: 'danger',
  canceled: 'neutral',
  interrupted: 'danger',
};

const BUDGET_UNIT_KEYS: Record<string, TranslationKey> = {
  tokens: 'agents.costValue.budgetUnit.tokens',
  requests: 'agents.costValue.budgetUnit.requests',
  usd_micros: 'agents.costValue.budgetUnit.usd_micros',
};

const BUDGET_STATUS_KEYS: Record<string, TranslationKey> = {
  active: 'agents.costValue.budgetStatus.active',
  disabled: 'agents.costValue.budgetStatus.disabled',
};

function rangeFor(period: Period) {
  const until = new Date();
  if (period === 'month') {
    return {
      since: new Date(Date.UTC(until.getUTCFullYear(), until.getUTCMonth(), 1)).toISOString(),
      until: until.toISOString(),
    };
  }
  const days = period === '7d' ? 7 : 30;
  return { since: new Date(until.getTime() - days * 86_400_000).toISOString(), until: until.toISOString() };
}

function formatUsdMicros(value: number) {
  return `$${(value / 1_000_000).toFixed(2)}`;
}

function formatRate(value: number | null) {
  return value == null ? '—' : `${Math.round(value * 100)}%`;
}

function formatBudgetUnits(unit: string, value: number) {
  if (unit === 'usd_micros') return formatUsdMicros(value);
  if (unit === 'tokens') return formatTokens(value);
  return value.toLocaleString();
}

export function CostValuePanel() {
  const t = useT();
  const [period, setPeriod] = useState<Period>('month');
  const [report, setReport] = useState<CostValueReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setReport(await fetchCostValueReport({ ...rangeFor(period), runLimit: 12 }));
    } catch {
      setError(t('agents.costValue.loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [period, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const organizationBudgets = useMemo(
    () => report?.budgets.filter((budget) => budget.scope_type === 'organization') ?? [],
    [report],
  );

  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-start gap-2 border-b border-edge px-3 py-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-fg">{t('agents.costValue.title')}</h3>
          <p className="mt-0.5 text-xs text-fg-muted">{t('agents.costValue.description')}</p>
        </div>
        <Select size="sm" inline value={period} onChange={(event) => setPeriod(event.target.value as Period)}>
          <option value="month">{t('agents.costValue.period.month')}</option>
          <option value="7d">{t('agents.costValue.period.sevenDays')}</option>
          <option value="30d">{t('agents.costValue.period.thirtyDays')}</option>
        </Select>
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={13} className="mr-1" />
          {t('common.refresh')}
        </Button>
      </div>

      {loading && !report ? (
        <div className="flex min-h-32 items-center justify-center">
          <Spinner />
        </div>
      ) : error && !report ? (
        <div className="px-3 py-6 text-center text-sm text-danger">{error}</div>
      ) : report ? (
        <div className="space-y-3 p-3">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
            <Metric
              icon={Bot}
              label={t('agents.costValue.llmCalls')}
              value={report.organization.total_calls.toLocaleString()}
            />
            <Metric
              icon={Coins}
              label={t('agents.costValue.tokenUsage')}
              value={formatTokens(report.organization.total_tokens)}
            />
            <Metric
              icon={Gauge}
              label={t('agents.costValue.completionRate')}
              value={formatRate(report.organization.effective_completion_rate)}
            />
            <Metric
              icon={DollarSign}
              label={t('agents.costValue.actualUsd')}
              value={formatUsdMicros(report.organization.actual_usd_micros)}
            />
          </div>

          <div className="rounded-md border border-info/30 bg-info-subtle px-3 py-2 text-xs text-fg-secondary">
            {t('agents.costValue.accountingNote')}
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Section title={t('agents.costValue.topAgents')} icon={Bot}>
              {report.agents.length === 0 ? (
                <EmptyLine text={t('agents.costValue.noUsage')} />
              ) : (
                report.agents.slice(0, 6).map((agent) => (
                  <div
                    key={agent.profile_id}
                    className="flex items-center gap-2 border-b border-edge py-2 last:border-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-fg" title={agent.name}>
                        {agent.name}
                        {agent.agent_version != null ? ` · v${agent.agent_version}` : ''}
                      </div>
                      <div className="text-[10px] text-fg-faint">
                        {t('agents.costValue.callsTokens', {
                          calls: agent.total_calls.toLocaleString(),
                          tokens: formatTokens(agent.total_tokens),
                        })}
                      </div>
                    </div>
                    <div className="text-right text-[10px] text-fg-muted">
                      <div>{formatDuration(agent.total_duration_ms)}</div>
                      {agent.actual_usd_micros !== 0 && <div>{formatUsdMicros(agent.actual_usd_micros)}</div>}
                    </div>
                  </div>
                ))
              )}
            </Section>

            <Section title={t('agents.costValue.topUsers')} icon={Users}>
              {report.users.length === 0 ? (
                <EmptyLine text={t('agents.costValue.noUsage')} />
              ) : (
                report.users.slice(0, 6).map((user) => (
                  <div key={user.user_id} className="flex items-center gap-2 border-b border-edge py-2 last:border-0">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-fg" title={user.email ?? user.user_id}>
                        {user.nickname ?? user.email ?? user.user_id}
                      </div>
                      <div className="text-[10px] text-fg-faint">
                        {t('agents.costValue.callsTokens', {
                          calls: user.total_calls.toLocaleString(),
                          tokens: formatTokens(user.total_tokens),
                        })}
                      </div>
                    </div>
                    <div className="text-right text-[10px] text-fg-muted">
                      <div>{formatDuration(user.total_duration_ms)}</div>
                      {user.actual_usd_micros !== 0 && <div>{formatUsdMicros(user.actual_usd_micros)}</div>}
                    </div>
                  </div>
                ))
              )}
            </Section>
          </div>

          <div className="grid gap-3 lg:grid-cols-2">
            <Section title={t('agents.costValue.runtimeByKind')} icon={Gauge}>
              {report.runtime_by_kind.length === 0 ? (
                <EmptyLine text={t('agents.costValue.noRuns')} />
              ) : (
                report.runtime_by_kind.map((runtime) => (
                  <div key={runtime.kind} className="flex items-center gap-2 border-b border-edge py-2 last:border-0">
                    <div className="min-w-0 flex-1 text-xs font-medium text-fg">
                      {RUNTIME_KIND_KEYS[runtime.kind] ? t(RUNTIME_KIND_KEYS[runtime.kind]) : runtime.kind}
                    </div>
                    <div className="text-right text-[10px] text-fg-muted">
                      <div>
                        {t('agents.costValue.runsAndRate', {
                          runs: runtime.total_runs,
                          rate: formatRate(runtime.effective_completion_rate),
                        })}
                      </div>
                      <div>
                        {t('agents.costValue.callsTokens', {
                          calls: runtime.llm_calls.toLocaleString(),
                          tokens: formatTokens(runtime.llm_tokens),
                        })}
                      </div>
                      <div>
                        {t('agents.costValue.avgDuration', { duration: formatDuration(runtime.avg_duration_ms) })}
                      </div>
                      {runtime.actual_usd_micros !== 0 && <div>{formatUsdMicros(runtime.actual_usd_micros)}</div>}
                    </div>
                  </div>
                ))
              )}
            </Section>

            <Section title={t('agents.costValue.organizationBudgets')} icon={Coins}>
              {organizationBudgets.length === 0 ? (
                <EmptyLine text={t('agents.costValue.noBudgets')} />
              ) : (
                organizationBudgets.map((budget) => (
                  <div key={budget.account_id} className="border-b border-edge py-2 last:border-0">
                    <div className="flex items-center gap-2">
                      <div className="min-w-0 flex-1 truncate text-xs font-medium text-fg" title={budget.scope_id}>
                        {budget.scope_id} ·
                        {BUDGET_UNIT_KEYS[budget.unit] ? t(BUDGET_UNIT_KEYS[budget.unit]) : budget.unit}
                      </div>
                      <Tag tone={budget.exceeded ? 'danger' : budget.status === 'active' ? 'success' : 'neutral'}>
                        {budget.exceeded
                          ? t('agents.costValue.exceeded')
                          : BUDGET_STATUS_KEYS[budget.status]
                            ? t(BUDGET_STATUS_KEYS[budget.status])
                            : budget.status}
                      </Tag>
                    </div>
                    <div className="mt-1 text-[10px] text-fg-faint">
                      {t('agents.costValue.budgetBalance', {
                        available: formatBudgetUnits(budget.unit, budget.available_units),
                        limit: formatBudgetUnits(budget.unit, budget.limit_units),
                        reserved: formatBudgetUnits(budget.unit, budget.reserved_units),
                      })}
                    </div>
                  </div>
                ))
              )}
            </Section>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-fg-muted">{t('agents.costValue.recentRuns')}</div>
            {report.recent_runs.length === 0 ? (
              <EmptyLine text={t('agents.costValue.noRuns')} />
            ) : (
              <div className="overflow-x-auto rounded-md border border-edge">
                <table className="min-w-[780px] w-full text-xs [&_td]:whitespace-nowrap [&_th]:whitespace-nowrap">
                  <thead className="bg-surface-sunken text-fg-muted">
                    <tr>
                      <th className="px-3 py-2 text-left font-medium">{t('agents.costValue.run')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('agents.costValue.kind')}</th>
                      <th className="px-3 py-2 text-left font-medium">{t('agents.costValue.status')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('agents.costValue.llmCalls')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('agents.costValue.tokenUsage')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('agents.costValue.duration')}</th>
                      <th className="px-3 py-2 text-right font-medium">{t('agents.costValue.actualUsd')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {report.recent_runs.map((run) => (
                      <tr key={run.id} className="hover:bg-surface-muted">
                        <td className="px-3 py-2">
                          <span className="block max-w-48 truncate selectable" title={run.id}>
                            {run.id}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-fg-secondary">
                          {RUNTIME_KIND_KEYS[run.kind] ? t(RUNTIME_KIND_KEYS[run.kind]) : run.kind}
                        </td>
                        <td className="px-3 py-2">
                          <Tag tone={STATUS_TONE[run.status] ?? 'neutral'}>
                            {RUNTIME_STATUS_KEYS[run.status] ? t(RUNTIME_STATUS_KEYS[run.status]) : run.status}
                          </Tag>
                        </td>
                        <td className="px-3 py-2 text-right text-fg-secondary">{run.llm_calls.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-fg-secondary">{formatTokens(run.llm_tokens)}</td>
                        <td className="px-3 py-2 text-right text-fg-secondary">{formatDuration(run.duration_ms)}</td>
                        <td className="px-3 py-2 text-right text-fg-secondary">
                          {formatUsdMicros(run.actual_usd_micros)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  );
}

function Metric({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div className="rounded-md border border-edge bg-surface-muted px-3 py-2">
      <div className="flex items-center gap-1 text-[10px] text-fg-muted">
        <Icon size={12} />
        {label}
      </div>
      <div className="mt-1 text-lg font-semibold text-fg">{value}</div>
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: LucideIcon; children: React.ReactNode }) {
  return (
    <div className="rounded-md border border-edge px-3 py-2">
      <div className="flex items-center gap-1 border-b border-edge pb-2 text-xs font-medium text-fg-muted">
        <Icon size={13} />
        {title}
      </div>
      {children}
    </div>
  );
}

function EmptyLine({ text }: { text: string }) {
  return <div className="py-4 text-center text-xs text-fg-faint">{text}</div>;
}
