/** An activation or reset link: set a password (and a name on activation), then straight in. */

import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PASSWORD_MIN_LENGTH } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { Button, ErrorBox, Field, Input, Spinner } from '@greenhouse/ui/kit';
import { useSession } from '../app/session';
import { api } from '../lib/api';
import { useT } from '../lib/i18n';
import { navigate } from '../lib/router';

export function ActivatePage({ token }: { token: string }) {
  const t = useT();
  const { signedInWithLink } = useSession();
  const link = useQuery({
    queryKey: ['link', token],
    queryFn: () => api.auth.inspectLink(token),
    enabled: token.length >= 16,
    retry: false,
  });
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const activating = link.data?.purpose === 'activate';

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (password.length < PASSWORD_MIN_LENGTH) return setError(t('activate.passwordHint'));
    setBusy(true);
    try {
      await api.auth.completeLink(token, password, activating && name.trim() ? name.trim() : undefined);
      signedInWithLink();
      navigate('#/c/main', { replace: true });
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof ApiClientError && caught.status < 500 ? t('activate.invalid') : t('login.offline'));
    }
  };

  let content;
  if (token.length < 16 || link.isError) content = <ErrorBox>{t('activate.invalid')}</ErrorBox>;
  else if (!link.data) content = <Spinner />;
  else
    content = (
      <>
        <h1>{activating ? t('activate.title') : t('activate.titleReset')}</h1>
        <p className="app-login-email">{link.data.email}</p>
        {activating && (
          <Field label={t('activate.name')}>
            <Input
              size="lg"
              autoComplete="name"
              value={name}
              placeholder={link.data.name}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        )}
        <Field label={t('activate.password')} description={t('activate.passwordHint')} error={error || undefined}>
          <Input
            size="lg"
            type="password"
            autoComplete="new-password"
            autoFocus
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setError('');
            }}
          />
        </Field>
        <Button type="submit" kind="primary" size="lg" loading={busy}>
          {t('activate.submit')}
        </Button>
      </>
    );

  return (
    <div className="app-login">
      <form className="app-login-card" onSubmit={(event) => void submit(event)} noValidate>
        <GreenhouseMark />
        {content}
      </form>
    </div>
  );
}
