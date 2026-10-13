/**
 * 设置 → 账号 (SET-01, AGNT-09): name, language and theme (applied at once), time zone, 「关于我」
 * that every Agent reads, and the password.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { Button, Field, Input, Segmented, Select, TextArea } from '@greenhouse/ui/kit';
import { PASSWORD_MIN_LENGTH, type UpdateMeInput } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { keys } from '../../data/query';
import { api } from '../../lib/api';
import { useI18n } from '../../lib/i18n';

const ZONES = (() => {
  try {
    return (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
})();

function useSaveMe() {
  const client = useQueryClient();
  const notify = useNotify();
  const { t } = useI18n();
  return useMutation({
    mutationFn: (input: UpdateMeInput) => api.me.update(input),
    onSuccess: (me) => client.setQueryData(keys.me, me),
    onError: (error) => notify(error instanceof ApiClientError ? error.message : t('common.error')),
  });
}

function Profile() {
  const { t } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const save = useSaveMe();
  const [name, setName] = useState(me.name);
  const [about, setAbout] = useState(me.about);
  const dirty = name.trim() !== me.name || about !== me.about;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim()) return;
    save.mutate({ name: name.trim(), about }, { onSuccess: () => notify(t('common.saved')) });
  };
  return (
    <form className="app-form" onSubmit={submit} aria-label={t('account.profile')}>
      <Field label={t('activate.name')} required>
        <Input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field label={t('account.about')} description={t('account.aboutHint')}>
        <TextArea value={about} maxLength={4000} maxRows={10} onChange={(event) => setAbout(event.target.value)} />
      </Field>
      <div>
        <Button kind="primary" type="submit" disabled={!dirty || !name.trim()} loading={save.isPending}>
          {t('common.save')}
        </Button>
      </div>
    </form>
  );
}

function Preferences() {
  const { t } = useI18n();
  const me = useMe();
  const save = useSaveMe();
  const languages = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
  ];
  const themes = [
    { value: 'system', label: t('account.themeSystem') },
    { value: 'light', label: t('account.themeLight') },
    { value: 'dark', label: t('account.themeDark') },
  ];
  const zones = useMemo(() => (ZONES.includes(me.timezone) ? ZONES : [me.timezone, ...ZONES]), [me.timezone]);
  return (
    <div className="app-settings-group">
      <div className="app-setting-row">
        <span className="app-setting-text">
          <strong>{t('account.language')}</strong>
        </span>
        <Segmented
          label={t('account.language')}
          items={languages}
          value={me.locale === 'en' ? 'en' : 'zh'}
          onChange={(locale) => save.mutate({ locale: locale as 'zh' | 'en' })}
        />
      </div>
      <div className="app-setting-row">
        <span className="app-setting-text">
          <strong>{t('account.theme')}</strong>
        </span>
        <Segmented
          label={t('account.theme')}
          items={themes}
          value={me.theme}
          onChange={(theme) => save.mutate({ theme: theme as 'system' | 'light' | 'dark' })}
        />
      </div>
      <div className="app-setting-row">
        <span className="app-setting-text">
          <strong>{t('account.timezone')}</strong>
          <span>{t('account.timezoneHint')}</span>
        </span>
        <Select
          label={t('account.timezone')}
          value={me.timezone}
          options={zones}
          searchable
          onChange={(timezone) => save.mutate({ timezone })}
        />
      </div>
    </div>
  );
}

function Password() {
  const { t } = useI18n();
  const notify = useNotify();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [error, setError] = useState('');
  const change = useMutation({
    mutationFn: () => api.me.changePassword(current, next),
    onSuccess: () => {
      setCurrent('');
      setNext('');
      notify(t('account.passwordChanged'));
    },
    onError: (caught) =>
      setError(
        caught instanceof ApiClientError && caught.status === 400 ? t('account.passwordWrong') : t('common.error'),
      ),
  });
  return (
    <form
      className="app-form"
      aria-label={t('account.password')}
      onSubmit={(event) => {
        event.preventDefault();
        if (next.length < PASSWORD_MIN_LENGTH) return setError(t('activate.passwordHint'));
        change.mutate();
      }}
    >
      <h2 className="app-section-title">{t('account.password')}</h2>
      <Field label={t('account.currentPassword')} required error={error || undefined}>
        <Input
          type="password"
          autoComplete="current-password"
          value={current}
          onChange={(event) => {
            setCurrent(event.target.value);
            setError('');
          }}
        />
      </Field>
      <Field label={t('activate.password')} required description={t('account.passwordHint')}>
        <Input
          type="password"
          autoComplete="new-password"
          value={next}
          onChange={(event) => {
            setNext(event.target.value);
            setError('');
          }}
        />
      </Field>
      <div>
        <Button type="submit" disabled={!current || !next} loading={change.isPending}>
          {t('account.changePassword')}
        </Button>
      </div>
    </form>
  );
}

export function AccountSection() {
  return (
    <>
      <Profile />
      <section className="app-section">
        <Preferences />
      </section>
      <section className="app-section">
        <Password />
      </section>
    </>
  );
}
