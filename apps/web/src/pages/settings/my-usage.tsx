/**
 * Settings › Usage — the member's own month: what they and their agents spent
 * on paid services (by service, by client, by agent over MCP) and their USD
 * limit. Reads `GET /api/usage/spend`, which only ever returns the caller's own
 * facts. The team view is Administration › Services & pricing.
 */

import { useCallback, useEffect, useState } from 'react';
import type { MySpendReport } from '@greenhouse/types/metering';
import { Button, EmptyState, SkeletonCard, Tag } from '../../components/ui';
import { ModulePage } from '../../components/app/module-page';
import { SettingsPanel, SettingsSection } from '../../components/settings';
import { KpiCard } from '../../components/usage/usage-widgets';
import { BudgetBar, SpendTable } from '../../components/usage/spend-widgets';
import { Bot, Gauge, Layers, Smartphone, RefreshCw } from '../../lib/icons';
import { fetchMySpend } from '../../lib/api/metering';
import { useT } from '../../lib/i18n';
import { clientLabelKey, formatUsd, serviceLabelKey } from '../../lib/metering/format';

export function MyUsagePanel() {
  const t = useT();
  const [report, setReport] = useState<MySpendReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setReport(await fetchMySpend());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const budget = report?.budget;
  const usedUp = budget ? budget.spent_usd_micros >= budget.limit_usd_micros : false;

  return (
    <ModulePage
      moduleId="settings.my-usage"
      layout="form"
      actions={
        <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
          <RefreshCw size={12} />
          {t('common.refresh')}
        </Button>
      }
    >
      {loading && !report ? (
        <SkeletonCard />
      ) : failed || !report || !budget ? (
        <EmptyState icon={Gauge} title={t('metering.loadFailed')} tone="danger" />
      ) : (
        <SettingsPanel>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiCard title={t('metering.my.spent')}>
              <div className="text-xl font-semibold tabular-nums text-fg" data-testid="my-usage-spent">
                {formatUsd(budget.spent_usd_micros)}
              </div>
              <div className="mt-1 text-[11px] text-fg-faint">
                {t('metering.calls')} {report.totals.calls.toLocaleString()}
              </div>
            </KpiCard>
            <KpiCard title={t('metering.my.limit')}>
              <div className="text-xl font-semibold tabular-nums text-fg">{formatUsd(budget.limit_usd_micros)}</div>
              <div className="mt-1">
                <Tag tone={budget.source === 'override' ? 'primary' : 'neutral'}>
                  {budget.source === 'override' ? t('metering.my.ownLimit') : t('metering.my.defaultLimit')}
                </Tag>
              </div>
            </KpiCard>
            <KpiCard title={t('metering.my.left')}>
              <div className={`text-xl font-semibold tabular-nums ${usedUp ? 'text-danger' : 'text-fg'}`}>
                {formatUsd(Math.max(0, budget.limit_usd_micros - budget.spent_usd_micros - budget.reserved_usd_micros))}
              </div>
              {budget.reserved_usd_micros > 0 && (
                <div className="mt-1 text-[11px] text-fg-faint">
                  {t('metering.my.reservedNow', { amount: formatUsd(budget.reserved_usd_micros) })}
                </div>
              )}
            </KpiCard>
          </div>

          <div className="space-y-1.5">
            <BudgetBar
              spent={budget.spent_usd_micros}
              reserved={budget.reserved_usd_micros}
              limit={budget.limit_usd_micros}
            />
            {usedUp && <p className="text-xs text-danger">{t('metering.my.usedUp')}</p>}
            {report.totals.unpriced_calls > 0 && (
              <p className="text-xs text-fg-muted">
                {t('metering.unpricedCount', { count: report.totals.unpriced_calls })} · {t('metering.unpricedHint')}
              </p>
            )}
          </div>

          {report.totals.calls === 0 ? (
            <EmptyState icon={Gauge} title={t('metering.my.noSpend')} tone="neutral" variant="compact" />
          ) : (
            <>
              <SettingsSection title={t('metering.byService')} icon={Layers}>
                <SpendTable
                  rows={report.by_service}
                  keyHeader={t('metering.service')}
                  emptyLabel={t('metering.noSpend')}
                  renderKey={(row) => {
                    const key = serviceLabelKey(row.key);
                    return <span>{key ? t(key) : row.key}</span>;
                  }}
                />
              </SettingsSection>
              <SettingsSection title={t('metering.byClient')} icon={Smartphone}>
                <SpendTable
                  rows={report.by_client}
                  keyHeader={t('metering.client')}
                  emptyLabel={t('metering.noSpend')}
                  renderKey={(row) => <span>{t(clientLabelKey(row.key))}</span>}
                />
              </SettingsSection>
              {report.by_agent_client.length > 0 && (
                <SettingsSection
                  title={t('metering.byAgentClient')}
                  description={t('metering.my.agentHint')}
                  icon={Bot}
                >
                  <SpendTable
                    rows={report.by_agent_client}
                    keyHeader={t('metering.agentClient')}
                    emptyLabel={t('metering.noSpend')}
                    renderKey={(row) => <span title={row.key}>{row.label ?? row.key}</span>}
                  />
                </SettingsSection>
              )}
            </>
          )}
        </SettingsPanel>
      )}
    </ModulePage>
  );
}
