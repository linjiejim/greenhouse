/**
 * `/oauth-consent?…` — an MCP client (Claude, Cursor, …) asks to act for the signed-in member.
 * The station's `/oauth/authorize` sends the browser here with the authorization request
 * unchanged; signed out, the root gate signs the member in and comes back.
 *
 * Shown: the client's name, the verbs it asks for, the data groups (all ticked; the member may
 * untick) and where the answer returns. Allow posts the ticked groups; Deny answers
 * `access_denied`. Either way the browser follows the station's answer only when it goes back to
 * the request's own address with the request's own state (src/login/consent.ts).
 */

import React, { useEffect, useMemo, useState } from 'react';
import { decideConsent, readConsent, type ConsentRequest } from '../src/api/entry';
import { useT, type TranslationKey } from '../src/lib/i18n';
import {
  actionScopes,
  followsRequest,
  grantedScopes,
  offeredGroups,
  redirectHost,
  type ConsentGroup,
} from '../src/login/consent';
import { EntryFrame, EntryState } from '../src/login/entry-frame.web';
import { heldEntryParams, releaseEntryParams } from '../src/login/entry-links';
import { useStationManifest } from '../src/plugins/store';
import { CLIENT_ROUTES } from '../src/shared/client-routes';
import { localize } from '../src/shared/plugins';
import { usePrefs } from '../src/store/prefs';
import { useTheme } from '../src/theme';
import { Icon } from '../src/ui/core';
import { GreenhouseMark } from '../src/ui/logo';

const ACTION_COPY: Record<'mcp:read' | 'mcp:write', { title: TranslationKey; detail: TranslationKey }> = {
  'mcp:read': { title: 'entry.consent.readTitle', detail: 'entry.consent.readDetail' },
  'mcp:write': { title: 'entry.consent.writeTitle', detail: 'entry.consent.writeDetail' },
};

export default function OAuthConsent() {
  const t = useT();
  const { hex } = useTheme();
  const lang = usePrefs((s) => s.lang);
  // The request as the browser parsed it (held before routing); the address is the fallback.
  const [request] = useState(() =>
    Object.fromEntries(heldEntryParams(CLIENT_ROUTES.oauthConsent) ?? new URLSearchParams(window.location.search)),
  );
  const manifest = useStationManifest((s) => s.data);
  const manifestStatus = useStationManifest((s) => s.status);
  useEffect(() => {
    if (useStationManifest.getState().status === 'idle') void useStationManifest.getState().refresh();
  }, []);
  const groupsKnown = manifestStatus === 'ready' || manifestStatus === 'error';

  const [consent, setConsent] = useState<ConsentRequest | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  useEffect(() => {
    let alive = true;
    void readConsent(request).then((result) => {
      if (!alive) return;
      if (!result.ok) return setProblem(result.message || t('entry.consent.unavailableTitle'));
      setConsent(result.data);
      // the common case is granting the request as asked: start from everything ticked
      setTicked(new Set(result.data.scopes.filter((scope) => scope.startsWith('mcp:'))));
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one read per page; the words are read at render
  }, [request]);

  const plugins = useMemo(() => (manifest.kind === 'v2' ? manifest.manifest.plugins : []), [manifest]);
  const offered = useMemo(() => (consent ? offeredGroups(consent.scopes, plugins) : []), [consent, plugins]);
  const actions = consent ? actionScopes(consent.scopes) : [];
  const selected = offered.filter((group) => ticked.has(group.scope)).length;
  const [deciding, setDeciding] = useState<'approve' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: 'approve' | 'deny') => {
    if (!consent || deciding) return;
    setDeciding(decision);
    setError(null);
    const result = await decideConsent(
      request,
      decision,
      decision === 'approve' ? grantedScopes(consent.scopes, offered, ticked) : undefined,
    );
    if (!result.ok || !followsRequest(result.data.redirect_to, consent)) {
      setError(result.ok ? t('entry.consent.badRedirect') : result.message || t('entry.consent.failed'));
      setDeciding(null);
      return;
    }
    releaseEntryParams(CLIENT_ROUTES.oauthConsent);
    window.location.assign(result.data.redirect_to);
  };

  const groupLabel = (group: ConsentGroup) =>
    'core' in group
      ? {
          title: t(`entry.groups.${group.core}.label` as TranslationKey),
          detail: t(`entry.groups.${group.core}.description` as TranslationKey),
        }
      : { title: localize(group.plugin.name, lang), detail: localize(group.plugin.description, lang) };

  const title = consent ? t('entry.consent.title', { name: consent.client.name }) : t('entry.consent.checking');
  return (
    <EntryFrame label={title} testID="consent-page" wide>
      <div className="gh-consent-top">
        <GreenhouseMark size={28} />
        <span className="gh-badge" data-tone="accent">
          <Icon name="shieldCheck" size={13} color={hex.accentText} />
          {t('entry.consent.secure')}
        </span>
      </div>
      {problem ? (
        <EntryState tone="danger" title={t('entry.consent.unavailableTitle')} detail={problem} testID="consent-unavailable" />
      ) : !consent ? (
        <EntryState tone="working" title={t('entry.consent.checking')} />
      ) : (
        <>
          <div className="gh-consent-client">
            <div className="gh-entry-badge">
              <Icon name="key" size={22} color={hex.accentText} />
            </div>
            <div>
              <h1 data-testid="consent-title">{title}</h1>
              <p>{t('entry.consent.hint')}</p>
            </div>
          </div>
          <div className="gh-consent-scopes">
            {actions.map((scope) => (
              <div key={scope} className="gh-consent-scope" data-testid={`consent-scope-${scope}`}>
                <header>
                  {t(ACTION_COPY[scope].title)}
                  <span className="gh-badge gh-mono">{scope}</span>
                </header>
                <p>{t(ACTION_COPY[scope].detail)}</p>
              </div>
            ))}
          </div>
          <section className="gh-consent-section" aria-busy={!groupsKnown}>
            <header>
              <h2>{t('entry.consent.groupsTitle')}</h2>
              {offered.length ? (
                <small>{t('entry.consent.selected', { count: selected, total: offered.length })}</small>
              ) : null}
            </header>
            {offered.length ? (
              <>
                <p>{t('entry.consent.groupsHint')}</p>
                <div className="gh-consent-groups">
                  {offered.map((group) => {
                    const words = groupLabel(group);
                    return (
                      <label key={group.scope} className="gh-consent-group">
                        <input
                          type="checkbox"
                          data-testid={`consent-group-${group.id}`}
                          checked={ticked.has(group.scope)}
                          disabled={deciding !== null}
                          onChange={(e) =>
                            setTicked((current) => {
                              const next = new Set(current);
                              if (e.target.checked) next.add(group.scope);
                              else next.delete(group.scope);
                              return next;
                            })
                          }
                        />
                        <span>
                          <strong>{words.title}</strong>
                          {words.detail ? <small>{words.detail}</small> : null}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {selected === 0 ? <p className="gh-consent-warning">{t('entry.consent.selectOne')}</p> : null}
              </>
            ) : groupsKnown ? (
              <p className="gh-consent-warning">{t('entry.consent.nothingOffered')}</p>
            ) : null}
          </section>
          <p className="gh-consent-return" data-testid="consent-return">
            {t('entry.consent.returnsTo')}{' '}
            <strong>{redirectHost(consent.redirect_uri)}</strong>
            <small>{consent.redirect_uri}</small>
          </p>
          {error ? (
            <p className="gh-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="gh-consent-actions">
            <button
              type="button"
              className="gh-secondary-button"
              data-testid="consent-deny"
              disabled={deciding !== null}
              onClick={() => void decide('deny')}
            >
              {t('entry.consent.deny')}
            </button>
            <button
              type="button"
              className="gh-primary"
              data-testid="consent-allow"
              disabled={deciding !== null || !groupsKnown || selected === 0}
              onClick={() => void decide('approve')}
            >
              {t('entry.consent.allow')}
            </button>
          </div>
        </>
      )}
    </EntryFrame>
  );
}
