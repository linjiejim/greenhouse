/**
 * Settings › Cloud computer — the member's own hosted sandbox (v1.6): whether
 * it is running, minutes this month, start / stop. Explains itself instead of
 * offering anything while the workspace switch is off or no E2B key is set.
 * Reads / writes `/api/computer` (only ever the caller's own computer).
 */

import { useCallback, useEffect, useState } from 'react';
import type { MyComputerReport } from '@greenhouse/types/metering';
import { Button, EmptyState, SkeletonCard, Tag, toast } from '@greenhouse/web/extension-kit';
import { ModulePage } from '@greenhouse/web/extension-kit';
import { SettingsPanel, SettingsSection } from '@greenhouse/web/extension-kit';
import { KpiCard } from '@greenhouse/web/extension-kit';
import { Monitor, RefreshCw } from '@greenhouse/web/extension-kit';
import { fetchMyComputer, startMyComputer, stopMyComputer } from '../../lib/api/computer';
import { useT } from '@greenhouse/web/extension-kit';
import { formatUsdPrice } from '@greenhouse/web/extension-kit';
import { relativeTime } from '@greenhouse/web/extension-kit';
import type { AnyTranslationKey as TranslationKey } from '@greenhouse/web/extension-kit';

const STATUS_KEYS: Record<string, TranslationKey> = {
  running: 'ext.computer.computer.statusRunning',
  starting: 'ext.computer.computer.statusStarting',
  stopping: 'ext.computer.computer.statusStopping',
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
      toast(t(action === 'start' ? 'ext.computer.computer.started' : 'ext.computer.computer.stopped'), 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : t('ext.computer.computer.actionFailed'), 'error');
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
        <EmptyState
          icon={Monitor}
          title={t('ext.computer.computer.off')}
          description={t('ext.computer.computer.offHint')}
          tone="neutral"
        />
      ) : !report.configured ? (
        <EmptyState
          icon={Monitor}
          title={t('ext.computer.computer.notConfigured')}
          description={t('ext.computer.computer.notConfiguredHint')}
          tone="neutral"
        />
      ) : (
        <SettingsPanel>
          <SettingsSection
            title={t('ext.computer.nav_computer')}
            description={t('ext.computer.computer.intro', { minutes: report.idle_minutes })}
            icon={Monitor}
            action={
              running ? (
                <Button size="sm" variant="secondary" disabled={busy} onClick={() => void act('stop')}>
                  {t('ext.computer.computer.stop')}
                </Button>
              ) : (
                <Button size="sm" disabled={busy || computer !== null} onClick={() => void act('start')}>
                  {t('ext.computer.computer.start')}
                </Button>
              )
            }
          >
            <p className="mb-3 text-xs text-warning" data-testid="computer-files-lost">
              {t('ext.computer.computer.filesLost', { minutes: report.idle_minutes })}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3" data-testid="computer-status">
              <KpiCard title={t('ext.computer.computer.status')}>
                <Tag tone={running ? 'success' : computer ? 'warning' : 'neutral'}>
                  {computer
                    ? t(STATUS_KEYS[computer.status] ?? 'ext.computer.computer.statusNone')
                    : t('ext.computer.computer.statusNone')}
                </Tag>
                {computer && (
                  <div className="mt-1 text-caption text-fg-faint">
                    {t('ext.computer.computer.lastUsedAt')} {relativeTime(computer.last_used_at)}
                  </div>
                )}
              </KpiCard>
              <KpiCard title={t('ext.computer.computer.minutesThisMonth')}>
                <div className="text-xl font-semibold tabular-nums text-fg">{report.minutes_this_month}</div>
              </KpiCard>
              <KpiCard title={t('metering.price')}>
                <div className="text-sm text-fg">
                  {report.price_per_minute_usd === null
                    ? t('ext.computer.computer.unpriced')
                    : t('ext.computer.computer.price', { price: formatUsdPrice(report.price_per_minute_usd) })}
                </div>
              </KpiCard>
            </div>
          </SettingsSection>
        </SettingsPanel>
      )}
    </ModulePage>
  );
}
