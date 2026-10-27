/**
 * `/bindings?<provider>=ok|error&reason=` — where linking a Feishu / WeCom account returns
 * (the provider plugin's callback, after it checked its single-use state). It says how it went and
 * leads to Me → Connections, where linked accounts are listed and unlinked
 * (src/connectors/provider-bindings.web.tsx). Nothing here changes a binding.
 */

import React, { useMemo } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useT, type TranslationKey } from '../src/lib/i18n';
import { EntryFrame, EntryState } from '../src/login/entry-frame.web';
import { bindingReturn } from '../src/plugins/identity';
import { identityGlue } from '../src/plugins/identity-registry';
import { goHome } from '../src/shell/nav';
import { CLIENT_ROUTES } from '../src/shared/client-routes';

const REASONS = new Set(['already_bound', 'state_expired', 'account_inactive', 'not_configured']);

export default function BindingResult() {
  const t = useT();
  const router = useRouter();
  const raw = useLocalSearchParams<Record<string, string | string[]>>();
  const result = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(raw)) if (typeof value === 'string') params.set(key, value);
    return bindingReturn(identityGlue, params);
  }, [raw]);

  const name = result ? t(result.provider.title) : '';
  const title = !result
    ? t('entry.bindings.unknownTitle')
    : result.ok
      ? t('entry.bindings.okTitle', { name })
      : t('entry.bindings.failedTitle', { name });
  const detail = !result
    ? t('entry.bindings.unknownDetail')
    : result.ok
      ? t('entry.bindings.okDetail')
      : REASONS.has(result.reason)
        ? t(`entry.bindings.${result.reason}` as TranslationKey, { name })
        : t('entry.bindings.other', { reason: result.reason });
  return (
    <EntryFrame label={title} testID="binding-result">
      <EntryState
        tone={!result ? 'neutral' : result.ok ? 'success' : 'danger'}
        title={title}
        detail={detail}
        testID={`binding-result-${!result ? 'none' : result.ok ? 'ok' : 'error'}`}
      />
      <div className="gh-entry-row">
        <button type="button" className="gh-entry-secondary" onClick={() => goHome(router)}>
          {t('entry.back')}
        </button>
        <button
          type="button"
          className="gh-entry-primary"
          data-testid="binding-open-connections"
          onClick={() => router.replace(CLIENT_ROUTES.connections as never)}
        >
          {t('entry.connector.toConnections')}
        </button>
      </div>
    </EntryFrame>
  );
}
