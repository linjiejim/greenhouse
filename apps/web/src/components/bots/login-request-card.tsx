/**
 * Secure sign-in card — the preferred way past a login wall.
 *
 * The values go once, straight to POST /api/bots/requests/:id; the server
 * fills them into the page on the computer and keeps them out of the
 * transcript and away from the model. They live only in this component's
 * state and are wiped the moment the request is sent. Browser autofill is
 * suppressed: the page is greenhouse, so the browser would offer the member's
 * greenhouse password for a third-party site.
 */

import { useState, type FormEvent } from 'react';
import type { BotLoginPayload, BotRequestDecision, BotRequestErrorCode, BotRequestView } from '@greenhouse/types/bots';
import { ArtifactCard, ArtifactCardActions } from '../chat/artifact-card';
import { FormField } from '../form';
import { Button, Checkbox, Input } from '../ui';
import { Lock } from '../../lib/icons';
import { useT } from '../../lib/i18n';
import { useRequestDecision, type RequestCardCallbacks } from './request-decision';
import { DetailList, useSettledStatus } from './request-card-parts';
import { InlineAction, type BotLookup } from './transcript-rows';

/**
 * Refusals where the page itself moved on — retyping won't help; the computer
 * or a fresh ask will. (`computer_restarted`: the restart closed the Bot's tab.)
 */
const PAGE_MOVED: ReadonlySet<string> = new Set<BotRequestErrorCode>([
  'page_gone',
  'origin_mismatch',
  'no_fields',
  'computer_restarted',
]);

/**
 * What the card sends: only the fields the member filled. A second card on a
 * two-step sign-in asks for the password alone, and a user-name-only submit is
 * followed to the next screen by the server — so either field is enough.
 */
export function loginValues(
  fields: { username: string; password: string; otp: string },
  opts: { otpOnly: boolean; saveToVault: boolean },
): NonNullable<BotRequestDecision['login']> | null {
  const username = opts.otpOnly ? '' : fields.username.trim();
  const password = opts.otpOnly ? '' : fields.password;
  const otp = fields.otp.trim();
  if (!username && !password && !otp) return null;
  return {
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(otp ? { otp } : {}),
    // Only a user name or a password is worth saving (the server agrees).
    ...(opts.saveToVault && (username || password) ? { save_to_vault: true } : {}),
    submit: true,
  };
}

export function LoginRequestCard({
  request,
  lookup,
  vaultAvailable,
  onSettled,
  onStale,
  onOpenComputer,
  onAskAgain,
}: RequestCardCallbacks & {
  request: BotRequestView;
  lookup: BotLookup;
  vaultAvailable: boolean;
  onOpenComputer: () => void;
  onAskAgain: (botId: string) => void;
}) {
  const t = useT();
  const payload = request.payload as BotLoginPayload;
  const name = lookup(request.bot_id)?.name ?? t('bots.deletedBot');
  const otpOnly = payload.kind === 'otp';
  const { busy, decide } = useRequestDecision(request, { onSettled, onStale });
  const { pending, expired, status } = useSettledStatus(request);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [otp, setOtp] = useState('');
  const [save, setSave] = useState(false);
  // Why the last attempt was refused while the card stays open (the toast said it once; this stays).
  const [refusal, setRefusal] = useState<string | null>(null);

  const login = loginValues({ username, password, otp }, { otpOnly, saveToVault: vaultAvailable && save });
  const canSubmit = login !== null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!login || busy) return;
    // Clear before awaiting: nothing secret should outlive the request in memory.
    // On a refusal the member retypes them on purpose.
    setPassword('');
    setOtp('');
    setRefusal(null);
    const outcome = await decide({ decision: 'approve', login });
    if (outcome.ok) setUsername('');
    else if (outcome.reason === 'refused') setRefusal(outcome.code ?? 'failed');
  };

  // Server-derived from the live page, so the member checks where the values go.
  const details = [
    ...(payload.origin ? [{ label: t('bots.requests.site'), value: payload.origin }] : []),
    ...(payload.url && payload.url !== payload.origin ? [{ label: t('bots.requests.page'), value: payload.url }] : []),
  ];
  const matches = payload.vault_matches ?? [];

  return (
    <ArtifactCard
      icon={<Lock size={14} />}
      title={t(otpOnly ? 'bots.requests.otpTitle' : 'bots.requests.loginTitle', { name })}
      meta={payload.reason || payload.origin || undefined}
      status={status}
      tone={pending ? 'accent' : 'neutral'}
      collapsed={!pending && !expired}
    >
      {/* Expired: the page it was raised for is long gone, so there is nothing to act on here. */}
      {expired && (
        <p className="text-xs text-fg-muted" data-testid="bots-login-expired">
          {t('bots.requests.loginExpired')}
        </p>
      )}
      {pending && (
        <form onSubmit={(event) => void submit(event)} className="space-y-3" autoComplete="off">
          <DetailList rows={details} />
          {matches.length > 0 && (
            <p className="text-[11px] text-fg-faint">
              {t('bots.requests.savedMatches', {
                items: matches.map((item) => `${item.label} (${item.username_hint})`).join(', '),
              })}
            </p>
          )}
          {!otpOnly && (
            <>
              <FormField label={t('bots.requests.username')}>
                <Input
                  size="sm"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  data-1p-ignore
                  data-lpignore="true"
                />
              </FormField>
              <FormField label={t('bots.requests.password')}>
                <Input
                  size="sm"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  data-1p-ignore
                  data-lpignore="true"
                />
              </FormField>
            </>
          )}
          <FormField label={t('bots.requests.otp')}>
            <Input
              size="sm"
              value={otp}
              inputMode="numeric"
              onChange={(event) => setOtp(event.target.value)}
              autoComplete="one-time-code"
              data-1p-ignore
              data-lpignore="true"
            />
          </FormField>
          {!otpOnly && vaultAvailable && (
            <Checkbox
              label={t('bots.requests.saveToVault')}
              checked={save}
              onChange={(event) => setSave(event.target.checked)}
            />
          )}
          {refusal && (
            <p className="text-[11px] leading-4 text-warning" role="status" data-testid="bots-login-refusal">
              {t(
                refusal === 'computer_restarted'
                  ? 'bots.requests.loginRestartedHint'
                  : PAGE_MOVED.has(refusal)
                    ? 'bots.requests.loginPageMovedHint'
                    : 'bots.requests.loginRetryHint',
                { name },
              )}
              {PAGE_MOVED.has(refusal) && request.bot_id && (
                <>
                  {' '}
                  <InlineAction onClick={() => onAskAgain(request.bot_id!)}>{t('bots.requests.askAgain')}</InlineAction>
                </>
              )}
            </p>
          )}
          <p className="text-[11px] leading-4 text-fg-faint">{t('bots.requests.loginHint', { name })}</p>
          <ArtifactCardActions>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void decide({ decision: 'deny' })}
            >
              {t('bots.requests.notNow')}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={onOpenComputer}>
              {t('bots.requests.openComputer')}
            </Button>
            <Button type="submit" size="sm" disabled={!canSubmit || busy}>
              {t(otpOnly ? 'bots.requests.submitCode' : 'bots.requests.signIn')}
            </Button>
          </ArtifactCardActions>
        </form>
      )}
    </ArtifactCard>
  );
}
