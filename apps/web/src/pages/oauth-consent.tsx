/**
 * OAuth consent screen shown after an MCP client opens /oauth/authorize.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MCP_RESOURCE_GROUP_IDS } from '@greenhouse/types/mcp';
import { AppLogo, Badge, Button, Card, Checkbox, Spinner } from '../components/ui';
import { Key, Shield, XCircle } from '../lib/icons';
import { decideOAuthAuthorization, validateOAuthAuthorization } from '../lib/api/oauth';
import { useT, type TranslationKey } from '../lib/i18n';
import { mcpGroupDescriptionKey, mcpGroupLabelKey } from '../lib/mcp-groups';

interface ConsentRequest {
  client: { id: string; name: string };
  redirect_uri: string;
  resource: string;
  scopes: string[];
  state: string;
}

/** Action scopes describe the verbs; they are shown, not chosen. */
function actionScopeLabel(scope: string): { title: TranslationKey; detail: TranslationKey } {
  if (scope === 'mcp:write') {
    return { title: 'oauthConsent.writeTitle', detail: 'oauthConsent.writeDetail' };
  }
  return { title: 'oauthConsent.readTitle', detail: 'oauthConsent.readDetail' };
}

export function OAuthConsentPage() {
  const t = useT();
  const params = useMemo(() => {
    const next = new URLSearchParams(window.location.search);
    next.delete('oauth_authorize');
    return next;
  }, []);
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [decision, setDecision] = useState<'approve' | 'deny' | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());

  useEffect(() => {
    let active = true;
    validateOAuthAuthorization(params)
      .then((value) => {
        if (!active) return;
        const consent = value as ConsentRequest;
        setRequest(consent);
        // Pre-tick everything the client asked for: the common case is granting
        // the request, and starting from nothing would read as a broken screen.
        setSelectedGroups(new Set(consent.scopes.filter((scope) => scope.startsWith('mcp:'))));
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : t('oauthConsent.validateFailed'));
      });
    return () => {
      active = false;
    };
  }, [params, t]);

  // Only the groups this request actually covers are offered.
  const offeredGroups = useMemo(
    () => (request ? MCP_RESOURCE_GROUP_IDS.filter((id) => request.scopes.includes(`mcp:${id}`)) : []),
    [request],
  );
  const actionScopes = useMemo(
    () => (request ? request.scopes.filter((scope) => scope === 'mcp:read' || scope === 'mcp:write') : []),
    [request],
  );
  const selectedCount = offeredGroups.filter((id) => selectedGroups.has(`mcp:${id}`)).length;

  const toggleGroup = useCallback((scope: string, checked: boolean) => {
    setSelectedGroups((current) => {
      const next = new Set(current);
      if (checked) next.add(scope);
      else next.delete(scope);
      return next;
    });
  }, []);

  const decide = useCallback(
    async (nextDecision: 'approve' | 'deny') => {
      setDecision(nextDecision);
      setError(null);
      try {
        const granted =
          nextDecision === 'approve'
            ? [...actionScopes, ...offeredGroups.map((id) => `mcp:${id}`).filter((s) => selectedGroups.has(s))]
            : undefined;
        const redirect = await decideOAuthAuthorization(params, nextDecision, granted);
        window.location.assign(redirect);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : t('oauthConsent.authorizationFailed'));
        setDecision(null);
      }
    },
    [params, t, actionScopes, offeredGroups, selectedGroups],
  );

  return (
    <div className="min-app-viewport bg-surface-sunken px-4 py-[max(2rem,env(safe-area-inset-top))] flex items-center justify-center">
      <Card className="w-full max-w-lg p-5 md:p-6">
        <div className="flex items-center justify-between gap-3 pb-4 border-b border-edge">
          <AppLogo size="sm" />
          <Badge variant="secondary">
            <Shield size={11} className="mr-1" />
            {t('oauthConsent.secureConnection')}
          </Badge>
        </div>

        {!request && !error && (
          <div className="py-12 flex items-center justify-center gap-2 text-sm text-fg-muted">
            <Spinner className="h-4 w-4" />
            {t('oauthConsent.validating')}
          </div>
        )}

        {error && !request && (
          <div className="py-10 text-center">
            <XCircle size={24} className="mx-auto text-danger mb-3" />
            <h1 className="text-base font-semibold text-fg mb-2">{t('oauthConsent.unavailable')}</h1>
            <p className="text-sm text-fg-muted">{error}</p>
          </div>
        )}

        {request && (
          <>
            <div className="py-5">
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-lg bg-primary-subtle text-primary-fg-strong flex items-center justify-center flex-shrink-0">
                  <Key size={18} />
                </div>
                <div className="min-w-0">
                  <h1 className="text-base font-semibold text-fg">
                    {t('oauthConsent.allowClient', { name: request.client.name })}
                  </h1>
                  <p className="text-xs text-fg-muted mt-1">{t('oauthConsent.permissionHint')}</p>
                </div>
              </div>

              <div className="mt-5 space-y-2">
                {actionScopes.map((scope) => {
                  const label = actionScopeLabel(scope);
                  return (
                    <div key={scope} className="rounded-lg border border-edge bg-surface-muted p-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-fg">{t(label.title)}</span>
                        <Badge variant="secondary">{scope}</Badge>
                      </div>
                      <p className="text-xs text-fg-muted mt-1">{t(label.detail)}</p>
                    </div>
                  );
                })}
              </div>

              {offeredGroups.length > 0 && (
                <div className="mt-5">
                  <div className="flex items-baseline justify-between gap-2 mb-2">
                    <h2 className="text-sm font-medium text-fg">{t('oauthConsent.capabilitiesTitle')}</h2>
                    <span className="text-[11px] text-fg-faint">
                      {t('oauthConsent.selectedCount', { count: selectedCount, total: offeredGroups.length })}
                    </span>
                  </div>
                  <p className="text-xs text-fg-muted mb-2">{t('oauthConsent.capabilitiesHint')}</p>
                  <div className="rounded-lg border border-edge divide-y divide-edge">
                    {offeredGroups.map((id) => {
                      const scope = `mcp:${id}`;
                      return (
                        <label key={id} className="flex items-start gap-2.5 p-3 cursor-pointer hover:bg-surface-muted">
                          <Checkbox
                            checked={selectedGroups.has(scope)}
                            onChange={(e) => toggleGroup(scope, e.target.checked)}
                            disabled={decision !== null}
                            className="mt-0.5"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm text-fg">{t(mcpGroupLabelKey(id))}</span>
                            <span className="block text-xs text-fg-muted mt-0.5">{t(mcpGroupDescriptionKey(id))}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {selectedCount === 0 && (
                    <p className="mt-2 text-xs text-warning">{t('oauthConsent.selectAtLeastOne')}</p>
                  )}
                </div>
              )}

              <p className="mt-4 text-[11px] text-fg-faint break-all">
                {t('oauthConsent.returningTo')} <span className="font-mono">{request.redirect_uri}</span>
              </p>
              {error && <p className="mt-3 text-xs text-danger">{error}</p>}
            </div>

            <div className="pt-4 border-t border-edge flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
              <Button variant="ghost" onClick={() => void decide('deny')} disabled={decision !== null}>
                {decision === 'deny' && <Spinner className="h-3.5 w-3.5" />}
                {t('oauthConsent.deny')}
              </Button>
              <Button
                onClick={() => void decide('approve')}
                disabled={decision !== null || (offeredGroups.length > 0 && selectedCount === 0)}
              >
                {decision === 'approve' && <Spinner className="h-3.5 w-3.5" />}
                {t('oauthConsent.allowConnection')}
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
