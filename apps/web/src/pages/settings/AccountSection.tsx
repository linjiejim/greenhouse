/**
 * 设置 → 账号 (SET-01, AGNT-09): name, language and theme (applied at once), time zone, 「关于我」
 * that every Agent reads, and the password.
 */

import { useMemo, useState, type FormEvent } from 'react';
import { Button, Field, FieldGroup, Input, Segmented, Select, Skeleton, TextArea } from '@greenhouse/ui/kit';
import { PASSWORD_MIN_LENGTH, type UpdateMeInput } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BudgetBar, formatCost, formatTokens } from '../../shell/usage';
import { ImagePicker } from '../../shell/ImagePicker';
import { MemberAvatar } from '../../shell/MemberAvatar';
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
      <FieldGroup label={t('account.avatar')}>
        <ImagePicker
          purpose="avatar"
          hasImage={!!me.avatar_url}
          preview={<MemberAvatar name={me.name} url={me.avatar_url} size={56} />}
          onPick={(fileId) => save.mutateAsync({ avatar_file_id: fileId })}
        />
      </FieldGroup>
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

function MyUsage() {
  const { t, locale } = useI18n();
  const usage = useQuery({ queryKey: ['usage', 'mine'], queryFn: () => api.usage.mine('month') });
  if (usage.isPending) return <Skeleton lines={3} />;
  if (usage.isError) return null;
  const data = usage.data;
  return (
    <section className="app-section" aria-label={t('usage.mine')}>
      <h2 className="app-section-title">{t('usage.mine')}</h2>
      <div className="app-stats-grid">
        <div className="app-stat">
          <span className="app-stat-label">{t('usage.tokens')}</span>
          <span className="app-stat-value">{formatTokens(data.totals.tokens, locale)}</span>
        </div>
        <div className="app-stat">
          <span className="app-stat-label">{t('usage.cost')}</span>
          <span className="app-stat-value">{formatCost(data.totals.cost_micros, locale)}</span>
          {data.totals.unpriced > 0 && (
            <span className="app-stat-hint">{t('usage.unpriced', { count: data.totals.unpriced })}</span>
          )}
        </div>
        <div className="app-stat">
          <span className="app-stat-label">{t('usage.requests')}</span>
          <span className="app-stat-value">{data.totals.requests.toLocaleString(locale)}</span>
        </div>
      </div>
      {data.budgets.map((budget) => (
        <BudgetBar key={budget.unit} spent={budget.spent} limit={budget.monthly_limit} unit={budget.unit} />
      ))}
      {data.by_agent.length > 0 && (
        <ul className="app-list">
          {data.by_agent.slice(0, 5).map((row) => (
            <li key={row.agent_id ?? 'none'} className="app-list-row is-static">
              <span className="app-list-main">
                <span className="app-list-title">{row.agent_id ? row.name : t('usage.outsideAgents')}</span>
              </span>
              <span className="app-list-time">{formatTokens(row.tokens, locale)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function AccountSection() {
  return (
    <>
      <Profile />
      <section className="app-section">
        <Preferences />
      </section>
      <MyUsage />
      <section className="app-section">
        <Password />
      </section>
    </>
  );
}
