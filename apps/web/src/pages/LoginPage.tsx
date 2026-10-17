/**
 * Sign-in (AUTH-01): the name, two fields and one large button. An unlocked desktop app also
 * names its server and asks for one on first launch or when the server cannot be reached.
 */

import { useState, type FormEvent } from 'react';
import { ApiClientError } from '@greenhouse/contract/client';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { Button, Field, Input } from '@greenhouse/ui/kit';
import { useSession } from '../app/session';
import { isDesktop, isFirstLaunch, useDesktopSettings } from '../lib/desktop';
import { useT } from '../lib/i18n';
import { ServerForm } from './ServerForm';

export function LoginPage() {
  const t = useT();
  const { bootstrapFailed } = useSession();
  const desktop = useDesktopSettings();
  const [changing, setChanging] = useState(false);
  if (isDesktop() && desktop.isPending) return <div className="app-login" />;
  const server = desktop.data && !desktop.data.apiBaseLocked ? desktop.data : undefined;
  if (!server) return <SignIn />;
  const firstLaunch = isFirstLaunch(server);
  if (!changing && !firstLaunch && !bootstrapFailed)
    return <SignIn server={server.apiBaseUrl} onChangeServer={() => setChanging(true)} />;
  return (
    <div className="app-login">
      <ServerForm
        className="app-login-card"
        header={
          <>
            <GreenhouseMark />
            <h1>{t('server.title')}</h1>
          </>
        }
        initial={firstLaunch ? '' : server.apiBaseUrl}
        initialError={bootstrapFailed && !firstLaunch ? 'unreachable' : undefined}
        description={t('server.addressHint')}
        submitLabel={t('server.connect')}
        size="lg"
        onCancel={changing && !bootstrapFailed ? () => setChanging(false) : undefined}
      />
    </div>
  );
}

function SignIn({ server, onChangeServer }: { server?: string; onChangeServer?: () => void }) {
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
        {server && (
          <p className="app-login-server">
            <span>{t('server.current', { server: new URL(server).host })}</span>
            <Button size="sm" kind="ghost" onClick={onChangeServer}>
              {t('server.change')}
            </Button>
          </p>
        )}
      </form>
    </div>
  );
}
