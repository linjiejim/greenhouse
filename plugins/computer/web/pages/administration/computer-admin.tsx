/**
 * Services & pricing › Cloud computer (super only): the workspace switch
 * (`ext.computer.computer.enabled`, a boolean workspace setting, off by default — shown as
 * its effective value and source, like the gateway switch), whether an E2B key is set, the limit,
 * and every computer running right now with a stop action. The per-minute
 * price is the `computer` row of the price table above, edited like any other.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AdminComputersReport } from '@greenhouse/types/metering';
import { Button, Tag, Toggle, toast } from '@greenhouse/web/extension-kit';
import { SettingsSection } from '@greenhouse/web/extension-kit';
import { Monitor, RotateCcw } from '@greenhouse/web/extension-kit';
import { fetchAdminComputers, setComputerEnabled, stopAdminComputer } from '../../lib/api/computer';
import { useT } from '@greenhouse/web/extension-kit';
import { clientLabelKey } from '@greenhouse/web/extension-kit';
import { relativeTime } from '@greenhouse/web/extension-kit';
import { flagSourceKey } from '@greenhouse/web/extension-kit';

export function ComputerAdminSection({ onChanged = () => {} }: { onChanged?: () => void }) {
  const t = useT();
  const [report, setReport] = useState<AdminComputersReport | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setReport(await fetchAdminComputers());
    } catch {
      setReport(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (work: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await work();
      toast(done, 'success');
      onChanged();
    } catch (err) {
      toast(err instanceof Error ? err.message : t('ext.computer.computer.actionFailed'), 'error');
    } finally {
      setBusy(false);
      void load();
    }
  };

  if (!report) return null;

  return (
    <SettingsSection
      title={t('ext.computer.computer.adminTitle')}
      description={t('ext.computer.computer.adminHint', { max: report.max_running, minutes: report.idle_minutes })}
      icon={Monitor}
    >
      <div className="mb-3 flex items-start gap-3" data-testid="computer-switch">
        <Toggle
          checked={report.switch.effective}
          // Turning it on needs a key; turning it off never does.
          disabled={busy || (!report.switch.effective && !report.configured)}
          onChange={(next) =>
            void run(
              () => setComputerEnabled(next),
              t(next ? 'ext.computer.computer.turnedOn' : 'ext.computer.computer.turnedOff'),
            )
          }
          label={t('ext.computer.computer.adminTitle')}
        />
        <div className="min-w-0 flex-1 text-xs font-medium text-fg">
          {report.switch.effective ? t('runtimeConfig.on') : t('runtimeConfig.off')}
          <span className="ml-2 font-normal text-fg-muted">
            {t(flagSourceKey(report.switch.source), { env: 'COMPUTER_ENABLED' })}
          </span>
        </div>
        {report.switch.override !== null && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => void run(() => setComputerEnabled(null), t('ext.computer.computer.switchReset'))}
          >
            <RotateCcw size={12} />
            {t('runtimeConfig.flagReset', {
              value: report.switch.fallback ? t('runtimeConfig.on') : t('runtimeConfig.off'),
            })}
          </Button>
        )}
      </div>
      {!report.configured && <p className="mb-2 text-xs text-warning">{t('ext.computer.computer.configureKey')}</p>}
      {report.running.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('ext.computer.computer.noneRunning')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs" data-testid="computers-running">
            <thead>
              <tr className="text-fg-faint">
                <th className="pb-2 text-left font-medium">{t('ext.computer.computer.member')}</th>
                <th className="pb-2 text-left font-medium">{t('ext.computer.computer.status')}</th>
                <th className="pb-2 text-left font-medium">{t('ext.computer.computer.client')}</th>
                <th className="pb-2 text-left font-medium">{t('ext.computer.computer.startedAt')}</th>
                <th className="pb-2 text-left font-medium">{t('ext.computer.computer.lastUsedAt')}</th>
                <th className="pb-2 text-right font-medium">{t('ext.computer.computer.minutesBilled')}</th>
                <th className="pb-2" />
              </tr>
            </thead>
            <tbody>
              {report.running.map((computer) => (
                <tr key={computer.id} className="border-b border-edge text-fg-secondary">
                  <td className="py-1.5 pr-3 text-fg">{computer.user_label ?? computer.user_id}</td>
                  <td className="py-1.5 pr-3">
                    <Tag tone={computer.status === 'running' ? 'success' : 'warning'}>{computer.status}</Tag>
                  </td>
                  <td className="py-1.5 pr-3">{t(clientLabelKey(computer.client))}</td>
                  <td className="py-1.5 pr-3">{relativeTime(computer.started_at)}</td>
                  <td className="py-1.5 pr-3">{relativeTime(computer.last_used_at)}</td>
                  <td className="py-1.5 pr-3 text-right tabular-nums">{computer.minutes_billed}</td>
                  <td className="py-1.5 text-right">
                    {computer.status === 'running' && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() =>
                          void run(() => stopAdminComputer(computer.id), t('ext.computer.computer.stopped'))
                        }
                      >
                        {t('ext.computer.computer.stop')}
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SettingsSection>
  );
}
