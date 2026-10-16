/**
 * The OAuth consent page (AUTH-06), outside the shell like activation: /oauth/authorize sends the
 * browser here with a one-time `request`, or with `error` when the link itself was bad. It says
 * which app asks (warning when it registered itself, so its name is only its own claim), where
 * the access goes back to, and what it may do; I may untick some. 允许 or 拒绝 both leave for
 * the app's address. A request belongs to the first member who opens it.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OAuthScope } from '@greenhouse/contract';
import { ApiClientError } from '@greenhouse/contract/client';
import { GreenhouseMark } from '@greenhouse/ui/components/brand';
import { Banner, Button, ErrorBox, Spinner } from '@greenhouse/ui/kit';
import { useSession } from '../app/session';
import type { MessageKey } from '../i18n/zh';
import { api } from '../lib/api';
import { errorText } from '../lib/errors';
import { useI18n, type Translate } from '../lib/i18n';
import { orderScopes, ScopeChecks } from './access/scopes';

/** What /oauth/authorize says was wrong with the link (`?error=`). */
const LINK_ERRORS: Record<string, MessageKey> = {
  invalid_client: 'consent.error.invalid_client',
  invalid_redirect_uri: 'consent.error.invalid_redirect_uri',
  invalid_scope: 'consent.error.invalid_scope',
  invalid_target: 'consent.error.invalid_target',
  invalid_request: 'consent.error.invalid_request',
  unsupported_response_type: 'consent.error.invalid_request',
};

/** Where the access goes: the host of a web address, or the scheme and name of an app's own one. */
export function returnsTo(uri: string): string {
  try {
    const url = new URL(uri);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.host
      : `${url.protocol}//${url.host}`.replace(/\/\/$/, '');
  } catch {
    return uri;
  }
}

function requestProblem(caught: unknown, t: Translate): string {
  if (caught instanceof ApiClientError) {
    if (caught.code === 'oauth_request_invalid') return t('consent.invalid');
    if (caught.code === 'client_unavailable') return t('consent.clientUnavailable');
  }
  return errorText(caught, t);
}

export function ConsentPage({ request, error }: { request: string; error: string }) {
  const { t } = useI18n();
  const { me, bootstrap } = useSession();
  const valid = !error && request.length >= 16;
  const consent = useQuery({
    queryKey: ['oauth', 'consent', request],
    queryFn: () => api.oauth.consent(request),
    enabled: valid && !!me,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const [picked, setPicked] = useState<OAuthScope[] | null>(null);
  const [deciding, setDeciding] = useState<'approve' | 'deny' | null>(null);
  const [failed, setFailed] = useState<unknown>(null);
  /** Decided: an app's own address (myapp://) may leave this page open behind it. */
  const [done, setDone] = useState<'approve' | 'deny' | null>(null);

  useEffect(() => {
    document.title = `${t('consent.page')} · ${bootstrap?.name || t('app.name')}`;
  }, [t, bootstrap?.name]);

  const decide = async (decision: 'approve' | 'deny', scopes: OAuthScope[]) => {
    setDeciding(decision);
    setFailed(null);
    try {
      const { redirect_to } = await api.oauth.decide({
        request,
        decision,
        ...(decision === 'approve' ? { scopes } : {}),
      });
      location.assign(redirect_to);
      setDone(decision);
    } catch (caught) {
      setDeciding(null);
      setFailed(caught);
    }
  };

  let content;
  if (!valid) {
    content = (
      <ErrorBox>
        {error ? t(LINK_ERRORS[error] ?? 'consent.error.other', { code: error }) : t('consent.invalid')}
      </ErrorBox>
    );
  } else if (consent.isError) {
    content = <ErrorBox>{requestProblem(consent.error, t)}</ErrorBox>;
  } else if (!consent.data || !me) {
    content = (
      <div className="app-center" role="status" aria-label={t('common.loading')}>
        <Spinner />
      </div>
    );
  } else {
    const ask = consent.data;
    const asked = orderScopes(ask.scopes);
    const scopes = picked ?? asked;
    const gone =
      failed instanceof ApiClientError && ['oauth_request_invalid', 'client_unavailable'].includes(failed.code);
    content = gone ? (
      <ErrorBox>{requestProblem(failed, t)}</ErrorBox>
    ) : (
      <>
        <h1>{t('consent.title', { name: ask.client.name })}</h1>
        <p className="app-consent-who">
          {t('consent.body', { name: ask.client.name, member: me.name, email: me.email })}
        </p>
        {ask.client.registration === 'dynamic' && <Banner tone="warning">{t('consent.dynamic')}</Banner>}
        <ScopeChecks
          label={t('consent.scopes')}
          value={scopes}
          scopes={asked}
          onChange={setPicked}
          error={scopes.length ? undefined : t('consent.pickOne')}
        />
        <p className="app-muted">
          {t('consent.returnsTo', { host: returnsTo(ask.redirect_uri) })}
          {ask.granted_scopes ? ` ${t('consent.again')}` : ''}
        </p>
        {failed !== null && (
          <p className="app-form-error" role="alert">
            {requestProblem(failed, t)}
          </p>
        )}
        {done ? (
          <p className="app-muted" role="status">
            {done === 'approve'
              ? t('consent.allowed', { host: returnsTo(ask.redirect_uri) })
              : t('consent.denied', { host: returnsTo(ask.redirect_uri) })}
          </p>
        ) : (
          <div className="app-consent-actions">
            <Button
              size="lg"
              loading={deciding === 'deny'}
              disabled={deciding === 'approve'}
              onClick={() => void decide('deny', scopes)}
            >
              {t('consent.deny')}
            </Button>
            <Button
              size="lg"
              kind="primary"
              loading={deciding === 'approve'}
              disabled={!scopes.length || deciding === 'deny'}
              onClick={() => void decide('approve', scopes)}
            >
              {t('consent.allow')}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="app-login">
      <main className="app-login-card app-consent" aria-label={t('consent.page')}>
        {bootstrap?.logo_url ? <img className="app-login-logo" src={bootstrap.logo_url} alt="" /> : <GreenhouseMark />}
        {content}
      </main>
    </div>
  );
}
