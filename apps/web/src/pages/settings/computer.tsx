/**
 * Settings › Cloud computer — the member's own hosted sandbox (v1.6): whether
 * it is running, minutes this month, start / stop. Explains itself instead of
 * offering anything while the workspace switch is off or no E2B key is set.
 * Reads / writes `/api/computer` (only ever the caller's own computer).
 */

import { useCallback, useEffect, useState } from 'react';
import type { MyComputerReport } from '@greenhouse/types/metering';
import { Button, EmptyState, SkeletonCard, Tag, toast } from '../../components/ui';
import { ModulePage } from '../../components/app/module-page';
import { SettingsPanel, SettingsSection } from '../../components/settings';
import { KpiCard } from '../../components/usage/usage-widgets';
import { Monitor, RefreshCw } from '../../lib/icons';
import { fetchMyComputer, startMyComputer, stopMyComputer } from '../../lib/api/computer';
import { useT } from '../../lib/i18n';
import { formatUsdPrice } from '../../lib/metering/format';
import { relativeTime } from '../../lib/utils';
import type { TranslationKey } from '../../lib/i18n';

const STATUS_KEYS: Record<string, TranslationKey> = {
  running: 'computer.statusRunning',
  starting: 'computer.statusStarting',
  stopping: 'computer.statusStopping',
};

export function ComputerPanel() {
  const t = useT();
  const [report, setReport] = useState<MyComputerReport | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(false);
    try {
      setReport(await fetchMyComputer());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: 'start' | 'stop') => {
    setBusy(true);
    try {
      if (action === 'start') await startMyComputer();
      else await stopMyComputer();
      toast(t(action === 'start' ? 'computer.started' : 'computer.stopped'), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('computer.actionFailed'), 'error');
    } finally {
      setBusy(false);
      void load();
    }
  };

  const computer = report?.computer ?? null;
  const running = computer?.status === 'running';

  return (
    <ModulePage
      moduleId="settings.computer"
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
      ) : failed || !report ? (
        <EmptyState icon={Monitor} title={t('metering.loadFailed')} tone="danger" />
      ) : !report.enabled ? (
        <EmptyState icon={Monitor} title={t('computer.off')} description={t('computer.offHint')} tone="neutral" />
      ) : !report.configured ? (
        <EmptyState
          icon={Monitor}
          title={t('computer.notConfigured')}
          description={t('computer.notConfiguredHint')}
          tone="neutral"
        />
      ) : (
        <SettingsPanel>
          <SettingsSection
            title={t('navigation.computer')}
            description={t('computer.intro', { minutes: report.idle_minutes })}
            icon={Monitor}
            action={
              running ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('stop')}>
                  {t('computer.stop')}
                </Button>
              ) : (
                <Button size="sm" disabled={busy || computer !== null} onClick={() => void act('start')}>
                  {t('computer.start')}
                </Button>
              )
            }
          >
            <p className="mb-3 text-xs text-warning" data-testid="computer-files-lost">
              {t('computer.filesLost', { minutes: report.idle_minutes })}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="computer-status">
              <KpiCard title={t('computer.status')}>
                <Tag tone={running ? 'success' : computer ? 'warning' : 'neutral'}>
                  {computer ? t(STATUS_KEYS[computer.status] ?? 'computer.statusNone') : t('computer.statusNone')}
                </Tag>
                {computer && (
                  <div className="mt-1 text-[11px] text-fg-faint">
                    {t('computer.lastUsedAt')} {relativeTime(computer.last_used_at)}
                  </div>
                )}
              </KpiCard>
              <KpiCard title={t('computer.minutesThisMonth')}>
                <div className="text-xl font-semibold tabular-nums text-fg">{report.minutes_this_month}</div>
              </KpiCard>
              <KpiCard title={t('metering.price')}>
                <div className="text-sm text-fg">
                  {report.price_per_minute_usd === null
                    ? t('computer.unpriced')
                    : t('computer.price', { price: formatUsdPrice(report.price_per_minute_usd) })}
                </div>
              </KpiCard>
            </div>
          </SettingsSection>
        </SettingsPanel>
      )}
    </ModulePage>
  );
}
