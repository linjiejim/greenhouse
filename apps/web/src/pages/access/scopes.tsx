/**
 * What an outside app may do with a member's access, in plain words (OPEN-01 scopes). The
 * consent page, the token form and the client form list them in OAUTH_SCOPES order.
 */

import { Checkbox, FieldGroup } from '@greenhouse/ui/kit';
import { OAUTH_SCOPES, type OAuthScope } from '@greenhouse/contract';
import type { MessageKey } from '../../i18n/zh';
import { useI18n, type Translate } from '../../lib/i18n';

export const SCOPE_WORDS: Record<OAuthScope, { label: MessageKey; hint: MessageKey }> = {
  'agents:read': { label: 'scope.agentsRead', hint: 'scope.agentsReadHint' },
  'agents:ask': { label: 'scope.agentsAsk', hint: 'scope.agentsAskHint' },
  'conversations:read': { label: 'scope.conversationsRead', hint: 'scope.conversationsReadHint' },
  'runs:read': { label: 'scope.runsRead', hint: 'scope.runsReadHint' },
  'apps:read': { label: 'scope.appsRead', hint: 'scope.appsReadHint' },
  'apps:write': { label: 'scope.appsWrite', hint: 'scope.appsWriteHint' },
  'memories:read': { label: 'scope.memoriesRead', hint: 'scope.memoriesReadHint' },
};

const isScope = (scope: string): scope is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(scope);

/** In OAUTH_SCOPES order, unknown ones dropped. */
export const orderScopes = (scopes: readonly string[]): OAuthScope[] =>
  OAUTH_SCOPES.filter((scope) => scopes.includes(scope));

/** 「查看你的 Agent、读取你的对话」: a grant's or a token's scopes in one line. */
export function scopeSummary(scopes: readonly string[], t: Translate): string {
  return scopes.map((scope) => (isScope(scope) ? t(SCOPE_WORDS[scope].label) : scope)).join(t('scope.separator'));
}

/** A checkbox per scope with what it lets the app do; `scopes` limits the list (what a client asked for). */
export function ScopeChecks({
  label,
  value,
  onChange,
  scopes = OAUTH_SCOPES,
  error,
}: {
  label: string;
  value: readonly OAuthScope[];
  onChange: (value: OAuthScope[]) => void;
  scopes?: readonly OAuthScope[];
  error?: string;
}) {
  const { t } = useI18n();
  return (
    <FieldGroup label={label} error={error}>
      <div className="app-stack">
        {scopes.map((scope) => (
          <Checkbox
            key={scope}
            checked={value.includes(scope)}
            onChange={(on) => onChange(orderScopes(on ? [...value, scope] : value.filter((item) => item !== scope)))}
            label={
              <span className="app-setting-text">
                <strong>{t(SCOPE_WORDS[scope].label)}</strong>
                <span>{t(SCOPE_WORDS[scope].hint)}</span>
              </span>
            }
          />
        ))}
      </div>
    </FieldGroup>
  );
}
