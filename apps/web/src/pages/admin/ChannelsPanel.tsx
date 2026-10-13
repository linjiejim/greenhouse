/**
 * 管理 → 服务 · 渠道 (ADM-05): where notifications go besides the app. Email through the
 * workspace's SMTP server, the Feishu and WeCom apps, and push to the phone apps. Settings that
 * come from the environment are read-only here; keys are write-only (left empty, a saved key
 * stays); 测试 sends a message to me.
 */

import { useState, type FormEvent } from 'react';
import { ChevronRight } from 'lucide-react';
import {
  Button,
  ErrorBox,
  Field,
  FieldGroup,
  Input,
  Overlay,
  OverlayActions,
  Segmented,
  Skeleton,
  StatusBadge,
  Switch,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { ChannelStatus, DeliveryChannel } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { relativeTime } from '../../lib/time';

const KEY = ['admin', 'channels'] as const;

const LABEL: Record<DeliveryChannel, MessageKey> = {
  email: 'channels.email',
  feishu: 'channels.feishu',
  wecom: 'channels.wecom',
  push: 'channels.push',
};

/** The default address of each vendor, for a new set-up. */
const BASE_URL: Partial<Record<DeliveryChannel, string>> = {
  feishu: 'https://open.feishu.cn',
  wecom: 'https://qyapi.weixin.qq.com',
  push: 'https://exp.host',
};

function SecretInput({
  label,
  saved,
  value,
  onChange,
  disabled,
}: {
  label: string;
  saved: boolean;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <Field label={label} description={saved ? t('channels.secretKept') : undefined}>
      <Input
        type="password"
        autoComplete="off"
        value={value}
        disabled={disabled}
        placeholder={saved ? t('channels.secretSaved') : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}

function ChannelDrawer({ status, onClose }: { status: ChannelStatus; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const readOnly = status.source === 'env';
  const settings = (status.settings ?? {}) as Record<string, unknown>;
  const text = (key: string, fallback = '') => String(settings[key] ?? fallback);
  const [form, setForm] = useState<Record<string, string>>({
    host: text('host'),
    port: settings.port ? String(settings.port) : '',
    security: text('security', 'tls'),
    username: text('username'),
    from_address: text('from_address'),
    from_name: text('from_name'),
    base_url: text('base_url', BASE_URL[status.channel] ?? ''),
    app_id: text('app_id'),
    corp_id: text('corp_id'),
    agent_id: settings.agent_id ? String(settings.agent_id) : '',
    secret: '',
  });
  const [enabled, setEnabled] = useState(status.source ? status.enabled : true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const set = (key: string) => (value: string) => setForm((current) => ({ ...current, [key]: value }));
  const field = (key: string, label: MessageKey, extra: { type?: string; description?: MessageKey } = {}) => (
    <Field label={t(label)} description={extra.description ? t(extra.description) : undefined}>
      <Input
        type={extra.type ?? 'text'}
        value={form[key] ?? ''}
        disabled={readOnly}
        onChange={(event) => set(key)(event.target.value)}
      />
    </Field>
  );
  const secretKey = { email: 'password', feishu: 'app_secret', wecom: 'secret', push: 'access_token' }[status.channel];

  const input = (): Record<string, unknown> => {
    const secret = form.secret ? { [secretKey]: form.secret } : {};
    switch (status.channel) {
      case 'email':
        return {
          host: form.host!.trim(),
          port: form.port ? Number(form.port) : null,
          security: form.security,
          username: form.username!.trim() || null,
          from_address: form.from_address!.trim(),
          from_name: form.from_name!.trim() || null,
          enabled,
          ...secret,
        };
      case 'feishu':
        return { base_url: form.base_url!.trim(), app_id: form.app_id!.trim(), enabled, ...secret };
      case 'wecom':
        return {
          base_url: form.base_url!.trim(),
          corp_id: form.corp_id!.trim(),
          agent_id: Number(form.agent_id),
          enabled,
          ...secret,
        };
      case 'push':
        return { base_url: form.base_url!.trim(), enabled, ...secret };
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setSaving(true);
    try {
      await api.admin.channels.save(status.channel, input() as never);
      await client.invalidateQueries({ queryKey: KEY });
      notify(t('common.saved'));
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiClientError && caught.status < 500 ? caught.message : errorText(caught, t));
    } finally {
      setSaving(false);
    }
  };

  const test = async () => {
    setTesting(true);
    try {
      const result = await api.admin.channels.test(status.channel);
      notify(
        result.ok
          ? result.delivered
            ? t('channels.testSent', { count: result.delivered })
            : t('channels.testNowhere')
          : t('channels.testFailed', { error: result.error ?? '' }),
      );
      void client.invalidateQueries({ queryKey: KEY });
    } catch (caught) {
      notify(errorText(caught, t));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Overlay title={t(LABEL[status.channel])} onClose={onClose}>
      <form id="channel-form" className="app-form" onSubmit={(event) => void submit(event)}>
        {readOnly && <p className="app-muted">{t('channels.fromEnv')}</p>}
        {status.channel === 'email' && (
          <>
            {field('host', 'channels.host')}
            {field('port', 'channels.port', { type: 'number', description: 'channels.portHint' })}
            <FieldGroup label={t('channels.security')}>
              <Segmented
                label={t('channels.security')}
                items={[
                  { value: 'tls', label: 'TLS' },
                  { value: 'starttls', label: 'STARTTLS' },
                  { value: 'none', label: t('channels.securityNone') },
                ]}
                value={form.security!}
                onChange={(value) => !readOnly && set('security')(value)}
              />
            </FieldGroup>
            {field('username', 'channels.username')}
            <SecretInput
              label={t('channels.password')}
              saved={status.secrets_set.includes('password')}
              value={form.secret!}
              onChange={set('secret')}
              disabled={readOnly}
            />
            {field('from_address', 'channels.fromAddress', { type: 'email' })}
            {field('from_name', 'channels.fromName')}
          </>
        )}
        {status.channel === 'feishu' && (
          <>
            {field('base_url', 'channels.baseUrl')}
            {field('app_id', 'channels.appId')}
            <SecretInput
              label={t('channels.appSecret')}
              saved={status.secrets_set.includes('app_secret')}
              value={form.secret!}
              onChange={set('secret')}
              disabled={readOnly}
            />
          </>
        )}
        {status.channel === 'wecom' && (
          <>
            {field('base_url', 'channels.baseUrl')}
            {field('corp_id', 'channels.corpId')}
            {field('agent_id', 'channels.agentId', { type: 'number' })}
            <SecretInput
              label={t('channels.secret')}
              saved={status.secrets_set.includes('secret')}
              value={form.secret!}
              onChange={set('secret')}
              disabled={readOnly}
            />
          </>
        )}
        {status.channel === 'push' && (
          <>
            {field('base_url', 'channels.baseUrl')}
            <SecretInput
              label={t('channels.accessToken')}
              saved={status.secrets_set.includes('access_token')}
              value={form.secret!}
              onChange={set('secret')}
              disabled={readOnly}
            />
          </>
        )}
        <div className="app-setting-row is-plain">
          <span className="app-setting-text">
            <strong>{t('channels.enabled')}</strong>
            <span>{t('channels.enabledHint')}</span>
          </span>
          <Switch label={t('channels.enabled')} checked={enabled} disabled={readOnly} onChange={setEnabled} />
        </div>
        {error && (
          <p className="app-request-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <OverlayActions>
        <Button
          className="app-actions-start"
          loading={testing}
          disabled={!status.configured}
          onClick={() => void test()}
        >
          {t('channels.test')}
        </Button>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        {!readOnly && (
          <Button kind="primary" type="submit" form="channel-form" loading={saving}>
            {t('common.save')}
          </Button>
        )}
      </OverlayActions>
    </Overlay>
  );
}

export function ChannelsList() {
  const { t, locale } = useI18n();
  const me = useMe();
  const data = useQuery({ queryKey: KEY, queryFn: () => api.admin.channels.list() });
  const [open, setOpen] = useState<DeliveryChannel | null>(null);
  if (data.isPending) return <Skeleton lines={4} />;
  if (data.isError) return <ErrorBox onRetry={() => void data.refetch()}>{errorText(data.error, t)}</ErrorBox>;
  const current = data.data.items.find((item) => item.channel === open);
  return (
    <section className="app-section">
      <h2 className="app-section-title">{t('channels.title')}</h2>
      <ul className="app-list app-bordered">
        {data.data.items.map((item) => (
          <li key={item.channel}>
            <button type="button" className="app-list-row" onClick={() => setOpen(item.channel)}>
              <span className="app-list-main">
                <span className="app-list-title">{t(LABEL[item.channel])}</span>
                <span className="app-list-meta">
                  {item.last_error
                    ? item.last_error
                    : item.last_success_at
                      ? t('channels.lastSent', {
                          time: relativeTime(item.last_success_at, { locale, timeZone: me.timezone }),
                        })
                      : t('channels.never')}
                </span>
              </span>
              <StatusBadge
                status={
                  item.last_error && item.configured
                    ? t('channels.failing')
                    : item.configured
                      ? t('provider.available')
                      : t('provider.notConfigured')
                }
                tone={item.last_error && item.configured ? 'danger' : item.configured ? 'success' : 'neutral'}
              />
              <ChevronRight size={icon.md} className="app-row-muted" />
            </button>
          </li>
        ))}
      </ul>
      {current && <ChannelDrawer key={current.channel} status={current} onClose={() => setOpen(null)} />}
    </section>
  );
}
