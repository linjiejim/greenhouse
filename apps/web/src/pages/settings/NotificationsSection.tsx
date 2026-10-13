/**
 * 设置 → 通知 (SET-02, NTF-04, NTF-05): which kinds of notification reach me where. The
 * notification center always has them; email, Feishu, WeCom and my phones only when an admin set
 * them up and they reach me. Previews stay off unless I turn them on: then messages name what
 * they are about, never the content of a card or a reply. My phones register themselves from
 * the app; here they can be tested or switched off.
 */

import { Bell, Smartphone } from 'lucide-react';
import { Button, Checkbox, Empty, ErrorBox, Skeleton, Switch } from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { DeliveryChannel, NotificationCategory, NotificationSettings } from '@greenhouse/contract';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';

const SETTINGS = ['me', 'notification-settings'] as const;
const DEVICES = ['me', 'push-devices'] as const;

const CATEGORY: Record<NotificationCategory, MessageKey> = {
  needs_you: 'notify.needsYou',
  replies: 'notify.replies',
  runs: 'notify.runs',
  other: 'notify.other',
};
const CHANNEL: Record<DeliveryChannel, MessageKey> = {
  email: 'notify.email',
  feishu: 'notify.feishu',
  wecom: 'notify.wecom',
  push: 'notify.push',
};

function Devices() {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const devices = useQuery({ queryKey: DEVICES, queryFn: () => api.me.pushDevices.list() });
  if (devices.isPending) return <Skeleton lines={2} />;
  if (devices.isError || !devices.data.enabled) return null;
  const failed = (error: unknown) => notify(errorText(error, t));
  return (
    <section className="app-section">
      <h2 className="app-section-title">{t('notify.devices')}</h2>
      {!devices.data.devices.length ? (
        <Empty icon={<Smartphone />} title={t('notify.noDevices')} description={t('notify.noDevicesHint')} />
      ) : (
        <ul className="app-list">
          {devices.data.devices.map((device) => (
            <li key={device.id} className="app-list-row is-static">
              <Smartphone size={icon.md} className="app-file-icon" aria-hidden />
              <span className="app-list-main">
                <span className="app-list-title">{device.platform === 'ios' ? 'iPhone / iPad' : 'Android'}</span>
                <span className="app-list-meta">
                  {t('notify.lastSeen', { time: relativeTime(device.last_seen_at, { locale, timeZone: me.timezone }) })}
                </span>
              </span>
              <Button
                size="sm"
                kind="ghost"
                onClick={() =>
                  void api.me.pushDevices
                    .test(device.id)
                    .then(() => notify(t('notify.testSent')))
                    .catch(failed)
                }
              >
                {t('notify.test')}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void api.me.pushDevices
                    .unregister(device.id)
                    .then(() => client.invalidateQueries({ queryKey: DEVICES }))
                    .catch(failed)
                }
              >
                {t('notify.turnOff')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function NotificationsSection() {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const settings = useQuery({ queryKey: SETTINGS, queryFn: () => api.me.notificationSettings.get() });
  const save = useMutation({
    mutationFn: (input: Parameters<typeof api.me.notificationSettings.save>[0]) =>
      api.me.notificationSettings.save(input),
    onSuccess: (saved) => client.setQueryData<NotificationSettings>(SETTINGS, saved),
    onError: (error) => notify(errorText(error, t)),
  });

  if (settings.isPending) return <Skeleton lines={5} />;
  if (settings.isError) {
    return <ErrorBox onRetry={() => void settings.refetch()}>{errorText(settings.error, t)}</ErrorBox>;
  }
  const { channels, categories, previews } = settings.data;
  const toggle = (category: NotificationCategory, channel: DeliveryChannel, on: boolean) =>
    save.mutate({ categories: { [category]: { ...categories[category], [channel]: on } } });

  return (
    <>
      <section className="app-section">
        {!channels.length && (
          <p className="app-muted">
            <Bell size={icon.sm} aria-hidden /> {t('notify.onlyInApp')}
          </p>
        )}
        <div className="app-table-wrap">
          <table className="app-table app-notify-table">
            <thead>
              <tr>
                <th>{t('notify.kind')}</th>
                <th>{t('notify.inApp')}</th>
                {channels.map((channel) => (
                  <th key={channel}>{t(CHANNEL[channel])}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(Object.keys(CATEGORY) as NotificationCategory[]).map((category) => (
                <tr key={category}>
                  <td>{t(CATEGORY[category])}</td>
                  <td>
                    <Checkbox
                      aria-label={t('notify.cell', { kind: t(CATEGORY[category]), channel: t('notify.inApp') })}
                      checked
                      disabled
                      onChange={() => undefined}
                    />
                  </td>
                  {channels.map((channel) => (
                    <td key={channel}>
                      <Checkbox
                        aria-label={t('notify.cell', { kind: t(CATEGORY[category]), channel: t(CHANNEL[channel]) })}
                        checked={categories[category][channel] === true}
                        disabled={save.isPending}
                        onChange={(on) => toggle(category, channel, on)}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {channels.length > 0 && (
        <section className="app-section">
          <div className="app-setting-row is-plain">
            <span className="app-setting-text">
              <strong>{t('notify.previews')}</strong>
              <span>{t('notify.previewsHint')}</span>
            </span>
            <Switch
              label={t('notify.previews')}
              checked={previews}
              disabled={save.isPending}
              onChange={(on) => save.mutate({ previews: on })}
            />
          </div>
        </section>
      )}
      <Devices />
    </>
  );
}
