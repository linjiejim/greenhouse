/**
 * Computer plugin › Cloud computers (an Admin section, manifest page `computer-admin`): the
 * workspace switch (`ext.computer.computer.enabled`), whether an E2B key is set, the limits, and
 * every computer running now with a stop action (/api/admin/computers). The per-minute price is
 * the `computer` row of Services & pricing.
 */
import React, { useCallback } from 'react';
import { get, post, seg } from '../../api/client';
import { useResource } from '../../data/use-resource';
import { usePrefs } from '../../store/prefs';
import { useT, localeOf } from '../../lib/i18n';
import { Icon } from '../../ui/core';
import { confirmAction } from '../../ui/dialogs';
import { toast } from '../../ui/toast';
import { AdminPage, Badge, Callout, Card, FlagSwitch, SectionState } from '../../admin/kit.web';
import { useWrite } from '../../admin/use-write';
import { dateTimeLabel, formatUsdPrice } from '../../admin/format';
import { clientKey } from '../../admin/metering-model';
import * as admin from '../../admin/api';
import type { WorkspaceFlagState } from '../../admin/types';
import type { AdminScreenEntry, AdminScreenProps } from '../admin-types';

interface AdminComputer {
  id: string;
  status: string;
  started_at: string;
  last_used_at: string;
  minutes_billed: number;
  client: string;
  user_id: string;
  user_label: string | null;
}
interface AdminComputersReport {
  switch: WorkspaceFlagState;
  configured: boolean;
  max_running: number;
  idle_minutes: number;
  price_per_minute_usd: number | null;
  running: AdminComputer[];
}

function ComputersScreen({ title }: AdminScreenProps) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const report = useResource(useCallback(() => get<AdminComputersReport>('/api/admin/computers'), []));
  const { busy, run } = useWrite();
  const data = report.data;
  const setSwitch = async (next: boolean | null) => {
    if (await run(() => admin.saveSettings({ 'ext.computer.computer.enabled': next }), t('admin.saveFailed'))) {
      toast(
        next === null
          ? t('admin.ext.computer.switchReset')
          : t(next ? 'admin.ext.computer.turnedOn' : 'admin.ext.computer.turnedOff'),
      );
      void report.refresh();
    }
  };
  const stop = async (computer: AdminComputer) => {
    const ok = await confirmAction({
      title: t('admin.ext.computer.stopTitle', { name: computer.user_label ?? computer.user_id }),
      message: t('admin.ext.computer.stopHint'),
      confirmLabel: t('admin.ext.computer.stop'),
      destructive: true,
    });
    if (!ok) return;
    if (await run(() => post(`/api/admin/computers/${seg(computer.id)}/stop`), t('admin.ext.computer.stopFailed'))) {
      toast(t('admin.ext.computer.stopped'));
      void report.refresh();
    }
  };
  return (
    <AdminPage
      title={title}
      testID="admin-computers"
      actions={
        <button
          className="gh-icon-button"
          aria-label={t('common.refresh')}
          disabled={report.loading}
          onClick={() => void report.refresh()}
        >
          <Icon name="refresh" size={16} />
        </button>
      }
    >
      {!data ? (
        <SectionState loading={report.loading} error={report.error} retry={() => void report.refresh()} />
      ) : (
        <>
          <p className="gh-hint">
            {t('admin.ext.computer.intro', { max: data.max_running, minutes: data.idle_minutes })}{' '}
            {data.price_per_minute_usd !== null
              ? t('admin.ext.computer.price', { price: formatUsdPrice(data.price_per_minute_usd) })
              : t('admin.ext.computer.unpriced')}
          </p>
          {!data.configured ? <Callout icon="key">{t('admin.ext.computer.configureKey')}</Callout> : null}
          <Card title={t('admin.ext.computer.switch')} icon="computer">
            <FlagSwitch
              testID="admin-computer-switch"
              state={data.switch}
              env="COMPUTER_ENABLED"
              label={t('admin.ext.computer.switch')}
              busy={busy}
              // turning it on needs a key; turning it off never does
              disabled={!data.switch.effective && !data.configured}
              onChange={(next) => void setSwitch(next)}
            />
          </Card>
          <Card title={t('admin.ext.computer.running')} icon="runs" flush>
            {data.running.length ? (
              <table className="gh-data-grid gh-admin-grid" data-testid="admin-computers-running">
                <thead>
                  <tr>
                    <th>{t('admin.ext.computer.member')}</th>
                    <th>{t('admin.metering.status')}</th>
                    <th>{t('admin.ext.computer.client')}</th>
                    <th>{t('admin.ext.computer.startedAt')}</th>
                    <th>{t('admin.ext.computer.lastUsedAt')}</th>
                    <th className="gh-number">{t('admin.ext.computer.minutes')}</th>
                    <th aria-label={t('admin.actions')} />
                  </tr>
                </thead>
                <tbody>
                  {data.running.map((c) => (
                    <tr key={c.id}>
                      <td>{c.user_label ?? c.user_id}</td>
                      <td>
                        <Badge tone={c.status === 'running' ? 'success' : 'warning'}>{c.status}</Badge>
                      </td>
                      <td>{t(`admin.metering.client.${clientKey(c.client)}`)}</td>
                      <td>{dateTimeLabel(c.started_at, localeOf(lang))}</td>
                      <td>{dateTimeLabel(c.last_used_at, localeOf(lang))}</td>
                      <td className="gh-number">{c.minutes_billed}</td>
                      <td className="gh-admin-actions">
                        {c.status === 'running' ? (
                          <button className="gh-link-button" disabled={busy} onClick={() => void stop(c)}>
                            {t('admin.ext.computer.stop')}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="gh-admin-empty-line">{t('admin.ext.computer.noneRunning')}</p>
            )}
          </Card>
        </>
      )}
    </AdminPage>
  );
}

export const adminScreen: AdminScreenEntry = {
  screen: 'computer-admin',
  icon: 'computer',
  component: ComputersScreen,
};
