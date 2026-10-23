/**
 * Services & pricing › Cloud computer (super only): the workspace switch
 * (`computer.enabled`, off by default), whether an E2B key is set, the limit,
 * and every computer running right now with a stop action. The per-minute
 * price is the `computer` row of the price table above, edited like any other.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AdminComputersReport } from '@greenhouse/types/metering';
import { Button, Tag, toast } from '../../components/ui';
import { SettingsSection } from '../../components/settings';
import { Monitor } from '../../lib/icons';
import { fetchAdminComputers, setComputerEnabled, stopAdminComputer } from '../../lib/api/computer';
import { useT } from '../../lib/i18n';
import { clientLabelKey } from '../../lib/metering/format';
import { relativeTime } from '../../lib/utils';

export function ComputerAdminSection({ onChanged }: { onChanged: () => void }) {
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
      toast(err instanceof Error ? err.message : t('computer.actionFailed'), 'error');
    } finally {
      setBusy(false);
      void load();
    }
  };

  if (!report) return null;

  return (
    <SettingsSection
      title={t('computer.adminTitle')}
      description={t('computer.adminHint', { max: report.max_running, minutes: report.idle_minutes })}
      icon={Monitor}
      action={
        <div className="flex items-center gap-2">
          <Tag tone={report.enabled ? 'success' : 'neutral'}>
            {report.enabled ? t('computer.switchOn') : t('computer.switchOff')}
          </Tag>
          <Button
            size="sm"
            variant={report.enabled ? 'secondary' : 'default'}
            disabled={busy || (!report.enabled && !report.configured)}
            data-testid="computer-switch"
            onClick={() =>
              void run(
                () => setComputerEnabled(!report.enabled),
                t(report.enabled ? 'computer.turnedOff' : 'computer.turnedOn'),
              )
            }
          >
            {report.enabled ? t('computer.turnOff') : t('computer.turnOn')}
          </Button>
        </div>
      }
    >
      {!report.configured && <p className="mb-2 text-xs text-warning">{t('computer.configureKey')}</p>}
      {report.running.length === 0 ? (
        <p className="text-xs text-fg-muted">{t('computer.noneRunning')}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs" data-testid="computers-running">
            <thead>
              <tr className="text-fg-faint">
                <th className="pb-2 text-left font-medium">{t('computer.member')}</th>
                <th className="pb-2 text-left font-medium">{t('computer.status')}</th>
                <th className="pb-2 text-left font-medium">{t('computer.client')}</th>
                <th className="pb-2 text-left font-medium">{t('computer.startedAt')}</th>
                <th className="pb-2 text-left font-medium">{t('computer.lastUsedAt')}</th>
                <th className="pb-2 text-right font-medium">{t('computer.minutesBilled')}</th>
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
                        onClick={() => void run(() => stopAdminComputer(computer.id), t('computer.stopped'))}
                      >
                        {t('computer.stop')}
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
