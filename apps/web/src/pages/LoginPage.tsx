/** Sign-in (AUTH-01): the name, two fields and one large button. Nothing else. */

import { useState, type FormEvent } from 'react';
import { ApiClientError } from '@greenhouse/contract/client';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { Button, Field, Input } from '@greenhouse/ui/kit';
import { useSession } from '../app/session';
import { useT } from '../lib/i18n';

export function LoginPage() {
  const t = useT();
  const { signIn, bootstrap } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await signIn(email.trim(), password);
    } catch (caught) {
      setError(
        caught instanceof ApiClientError
          ? caught.status === 429
            ? t('login.tooMany')
            : caught.status >= 500
              ? t('login.offline')
              : t('login.failed')
          : t('login.offline'),
      );
      setBusy(false);
    }
  };

  return (
    <div className="app-login">
      <form className="app-login-card" onSubmit={(event) => void submit(event)} noValidate>
        {bootstrap?.logo_url ? <img className="app-login-logo" src={bootstrap.logo_url} alt="" /> : <GreenhouseMark />}
        <h1>{bootstrap?.name || t('app.name')}</h1>
        <Field label={t('login.email')}>
          <Input
            size="lg"
            type="email"
            name="email"
            autoComplete="username"
            autoFocus
            required
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError('');
            }}
          />
        </Field>
        <Field label={t('login.password')} error={error || undefined}>
          <Input
            size="lg"
            type="password"
            name="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setError('');
            }}
          />
        </Field>
        <Button type="submit" kind="primary" size="lg" loading={busy} disabled={!email.trim() || !password}>
          {t('login.submit')}
        </Button>
      </form>
    </div>
  );
}
