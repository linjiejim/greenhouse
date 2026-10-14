/**
 * 设置 → 连接 · 邮箱 (SET-05, OPEN-05): connect my own mailbox to the built-in mailbox connector.
 * The server tries IMAP and SMTP with these settings before it keeps anything; when either refuses,
 * the reason shows here. A common provider fills in its servers; the password is write-only.
 */

import { useState, type FormEvent } from 'react';
import { Button, Field, FieldGroup, Input, Overlay, OverlayActions, Segmented, Select } from '@greenhouse/ui/kit';
import type { Connection, MailSecurity } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { connectorKeys } from '../../data/connectors';
import type { MessageKey } from '../../i18n/zh';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';

interface Server {
  host: string;
  port: string;
  security: MailSecurity;
}

/** Common providers and their servers (as each documents them). */
const PRESETS: { id: string; label: MessageKey; imap: Server; smtp: Server }[] = [
  {
    id: 'gmail',
    label: 'connections.preset.gmail',
    imap: { host: 'imap.gmail.com', port: '993', security: 'tls' },
    smtp: { host: 'smtp.gmail.com', port: '465', security: 'tls' },
  },
  {
    id: 'outlook',
    label: 'connections.preset.outlook',
    imap: { host: 'outlook.office365.com', port: '993', security: 'tls' },
    smtp: { host: 'smtp.office365.com', port: '587', security: 'starttls' },
  },
  {
    id: 'icloud',
    label: 'connections.preset.icloud',
    imap: { host: 'imap.mail.me.com', port: '993', security: 'tls' },
    smtp: { host: 'smtp.mail.me.com', port: '587', security: 'starttls' },
  },
  {
    id: 'qq',
    label: 'connections.preset.qq',
    imap: { host: 'imap.qq.com', port: '993', security: 'tls' },
    smtp: { host: 'smtp.qq.com', port: '465', security: 'tls' },
  },
  {
    id: '163',
    label: 'connections.preset.163',
    imap: { host: 'imap.163.com', port: '993', security: 'tls' },
    smtp: { host: 'smtp.163.com', port: '465', security: 'tls' },
  },
  {
    id: 'exmail',
    label: 'connections.preset.exmail',
    imap: { host: 'imap.exmail.qq.com', port: '993', security: 'tls' },
    smtp: { host: 'smtp.exmail.qq.com', port: '465', security: 'tls' },
  },
  {
    id: 'feishu',
    label: 'connections.preset.feishu',
    imap: { host: 'imap.feishu.cn', port: '993', security: 'tls' },
    smtp: { host: 'smtp.feishu.cn', port: '465', security: 'tls' },
  },
];

const blank: Server = { host: '', port: '993', security: 'tls' };

function ServerFields({
  legend,
  value,
  onChange,
}: {
  legend: string;
  value: Server;
  onChange: (value: Server) => void;
}) {
  const { t } = useI18n();
  return (
    <FieldGroup label={legend}>
      <div className="app-form-row">
        <Field label={t('connections.mailboxHost')} required>
          <Input value={value.host} onChange={(event) => onChange({ ...value, host: event.target.value })} />
        </Field>
        <Field label={t('connections.mailboxPort')} required>
          <Input
            type="number"
            value={value.port}
            onChange={(event) => onChange({ ...value, port: event.target.value })}
          />
        </Field>
      </div>
      <Segmented
        label={`${legend} · ${t('connections.mailboxSecurity')}`}
        items={[
          { value: 'tls', label: 'TLS' },
          { value: 'starttls', label: 'STARTTLS' },
          { value: 'none', label: t('connections.mailboxPlain') },
        ]}
        value={value.security}
        onChange={(security) => onChange({ ...value, security: security as MailSecurity })}
      />
    </FieldGroup>
  );
}

export function MailboxDialog({ current, onClose }: { current: Connection | null; onClose: () => void }) {
  const { t } = useI18n();
  const notify = useNotify();
  const client = useQueryClient();
  const settings = current?.mailbox ?? null;
  const [preset, setPreset] = useState('');
  const [address, setAddress] = useState(settings?.address ?? '');
  const [name, setName] = useState(current && current.display_name !== settings?.address ? current.display_name : '');
  const [imap, setImap] = useState<Server>(
    settings ? { ...settings.imap, port: String(settings.imap.port) } : { ...blank },
  );
  const [smtp, setSmtp] = useState<Server>(
    settings ? { ...settings.smtp, port: String(settings.smtp.port) } : { ...blank, port: '465' },
  );
  const [username, setUsername] = useState(settings && settings.username !== settings.address ? settings.username : '');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const choose = (id: string) => {
    setPreset(id);
    const found = PRESETS.find((entry) => entry.id === id);
    if (found) {
      setImap({ ...found.imap });
      setSmtp({ ...found.smtp });
    }
  };

  const ready =
    !!address.trim() && !!imap.host.trim() && !!smtp.host.trim() && !!imap.port && !!smtp.port && !!password;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setError('');
    try {
      const connected = await api.me.connections.connect({
        kind: 'email',
        address: address.trim(),
        ...(name.trim() ? { display_name: name.trim() } : {}),
        imap: { host: imap.host.trim(), port: Number(imap.port), security: imap.security },
        smtp: { host: smtp.host.trim(), port: Number(smtp.port), security: smtp.security },
        ...(username.trim() ? { username: username.trim() } : {}),
        password,
      });
      await client.invalidateQueries({ queryKey: connectorKeys.mine });
      notify(t('connections.connectedToast', { name: connected.mailbox?.address ?? t('connections.mailbox') }));
      onClose();
    } catch (caught) {
      setSaving(false);
      if (caught instanceof ApiClientError && caught.code === 'mailbox_rejected') {
        const details = (caught.details ?? {}) as { imap?: string | null; smtp?: string | null };
        const reason = [details.imap, details.smtp].filter(Boolean).join(' · ');
        setError(t('connections.mailboxRejected', { reason }));
      } else setError(errorText(caught, t));
    }
  };

  return (
    <Overlay title={t('connections.mailboxTitle')} onClose={onClose}>
      <form id="mailbox-connection" className="app-form" onSubmit={(event) => void submit(event)}>
        <p className="app-muted">{t('connections.mailboxIntro')}</p>
        <FieldGroup label={t('connections.mailboxPreset')}>
          <Select
            label={t('connections.mailboxPreset')}
            value={preset}
            placeholder={t('connections.mailboxPresetOther')}
            options={PRESETS.map((entry) => ({ value: entry.id, label: t(entry.label) }))}
            onChange={choose}
          />
        </FieldGroup>
        <Field label={t('connections.mailboxAddress')} required>
          <Input
            type="email"
            autoComplete="email"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </Field>
        <Field label={t('connections.mailboxName')}>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <ServerFields legend={t('connections.mailboxImap')} value={imap} onChange={setImap} />
        <ServerFields legend={t('connections.mailboxSmtp')} value={smtp} onChange={setSmtp} />
        <Field label={t('connections.mailboxUser')} description={t('connections.mailboxUserHint')}>
          <Input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} />
        </Field>
        <Field label={t('connections.mailboxPassword')} required>
          <Input
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </Field>
        {error && (
          <p className="app-form-error" role="alert">
            {error}
          </p>
        )}
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form="mailbox-connection" loading={saving} disabled={!ready}>
          {t('connections.mailboxSave')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}
