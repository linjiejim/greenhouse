/**
 * 设置 → 外部访问 (SET-08): outside apps acting as me through /api/mcp, never beyond what I can
 * do. Personal access tokens for the CLI and scripts (a token shows once, then only its name);
 * apps I authorized, with machine clients an admin bound to me waiting for my approval. Revoking
 * ends their tokens at once.
 */

import { useState, type FormEvent } from 'react';
import { KeyRound, Plus } from 'lucide-react';
import {
  Button,
  ConfirmDialog,
  Empty,
  ErrorBox,
  Field,
  FieldGroup,
  HelpHint,
  Input,
  Overlay,
  OverlayActions,
  Select,
  Skeleton,
  StatusBadge,
} from '@greenhouse/ui/kit';
import { icon } from '@greenhouse/ui/tokens';
import type { CreatedPersonalToken, Grant, OAuthScope, PersonalToken } from '@greenhouse/contract';
import { useQueryClient } from '@tanstack/react-query';
import { useNotify } from '../../app/notify';
import { useMe } from '../../app/session';
import { accessKeys, useGrants, usePersonalTokens } from '../../data/access';
import { api } from '../../lib/api';
import { errorText } from '../../lib/errors';
import { useI18n } from '../../lib/i18n';
import { calendarDay, relativeTime } from '../../lib/time';
import { ScopeChecks, scopeSummary } from '../access/scopes';
import { ShownOnce } from '../access/ShownOnce';

/** Lifetimes to pick; the server allows 1–366 days. */
const DAYS = [7, 30, 90, 180, 366];

function TokenDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (token: CreatedPersonalToken) => void;
}) {
  const { t } = useI18n();
  const client = useQueryClient();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<OAuthScope[]>(['agents:read', 'agents:ask']);
  const [days, setDays] = useState('30');
  const [error, setError] = useState('');
  const [scopeError, setScopeError] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!scopes.length) return setScopeError(t('access.pickScope'));
    setSaving(true);
    try {
      const created = await api.me.tokens.create({ name: name.trim(), scopes, expires_in_days: Number(days) });
      await client.invalidateQueries({ queryKey: accessKeys.tokens });
      onClose();
      onCreated(created);
    } catch (caught) {
      setSaving(false);
      setError(errorText(caught, t));
    }
  };
  return (
    <Overlay variant="dialog" title={t('access.createToken')} onClose={onClose}>
      <form id="personal-token" className="app-form" onSubmit={(event) => void submit(event)}>
        <Field
          label={t('access.tokenName')}
          required
          description={t('access.tokenNameHint')}
          error={error || undefined}
        >
          <Input
            value={name}
            maxLength={80}
            autoFocus
            onChange={(event) => {
              setName(event.target.value);
              setError('');
            }}
          />
        </Field>
        <ScopeChecks
          label={t('access.scopes')}
          value={scopes}
          error={scopeError || undefined}
          onChange={(next) => {
            setScopes(next);
            setScopeError('');
          }}
        />
        <FieldGroup label={t('access.expiry')}>
          <Select
            label={t('access.expiry')}
            value={days}
            options={DAYS.map((count) => ({ value: String(count), label: t('access.days', { count }) }))}
            onChange={setDays}
          />
        </FieldGroup>
      </form>
      <OverlayActions>
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button kind="primary" type="submit" form="personal-token" loading={saving} disabled={!name.trim()}>
          {t('access.createToken')}
        </Button>
      </OverlayActions>
    </Overlay>
  );
}

function Tokens() {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const tokens = usePersonalTokens();
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<CreatedPersonalToken | null>(null);
  const [revoking, setRevoking] = useState<PersonalToken | null>(null);
  const when = { locale, timeZone: me.timezone };
  const items = tokens.data?.items ?? [];
  return (
    <section className="app-section" aria-label={t('access.tokens')}>
      <div className="app-section-heading">
        <span className="app-heading-with-help">
          <h2 className="app-section-title">{t('access.tokens')}</h2>
          <HelpHint label={t('access.tokens')}>{t('access.tokensHelp')}</HelpHint>
        </span>
        <Button onClick={() => setCreating(true)}>
          <Plus size={icon.md} />
          {t('access.createToken')}
        </Button>
      </div>
      {tokens.isPending ? (
        <Skeleton lines={2} />
      ) : tokens.isError ? (
        <ErrorBox onRetry={() => void tokens.refetch()}>{t('common.error')}</ErrorBox>
      ) : items.length ? (
        <ul className="app-list app-bordered">
          {items.map((token) => (
            <li key={token.id} className="app-list-row is-static">
              <KeyRound size={icon.md} className="app-row-muted" />
              <span className="app-list-main">
                <span className="app-list-title">{token.name}</span>
                <span className="app-list-meta">
                  {[
                    scopeSummary(token.scopes, t),
                    token.last_used_at
                      ? t('access.lastUsed', { time: relativeTime(token.last_used_at, when) })
                      : t('access.neverUsed'),
                    token.status === 'active' && t('access.expires', { day: calendarDay(token.expires_at, when) }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              {token.status === 'expired' && <StatusBadge status={t('access.expired')} tone="neutral" />}
              <Button size="sm" kind="danger" onClick={() => setRevoking(token)}>
                {t('access.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon={<KeyRound />} title={t('access.noTokens')} />
      )}
      {creating && <TokenDialog onClose={() => setCreating(false)} onCreated={setCreated} />}
      {created && (
        <ShownOnce
          title={t('access.tokenCreated', { name: created.name })}
          fields={[{ label: t('access.token'), value: created.token }]}
          onClose={() => setCreated(null)}
        >
          {t('access.tokenOnce')}
        </ShownOnce>
      )}
      {revoking && (
        <ConfirmDialog
          danger
          title={t('access.revokeTokenTitle', { name: revoking.name })}
          confirmLabel={t('access.revoke')}
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const target = revoking;
            setRevoking(null);
            void api.me.tokens
              .revoke(target.id)
              .then(() => {
                notify(t('access.tokenRevoked', { name: target.name }));
                return client.invalidateQueries({ queryKey: accessKeys.tokens });
              })
              .catch((caught: unknown) => notify(errorText(caught, t)));
          }}
        >
          {t('access.revokeTokenBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}

function Grants() {
  const { t, locale } = useI18n();
  const me = useMe();
  const notify = useNotify();
  const client = useQueryClient();
  const grants = useGrants();
  const [revoking, setRevoking] = useState<Grant | null>(null);
  const when = { locale, timeZone: me.timezone };
  const refresh = () => client.invalidateQueries({ queryKey: accessKeys.grants });
  // Waiting for me first.
  const items = [...(grants.data?.items ?? [])].sort(
    (a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'),
  );
  const approve = (grant: Grant) =>
    void api.me.grants
      .approve(grant.id)
      .then(() => {
        notify(t('access.approved', { name: grant.client.name }));
        return refresh();
      })
      .catch((caught: unknown) => notify(errorText(caught, t)));
  return (
    <section className="app-section" aria-label={t('access.apps')}>
      <h2 className="app-section-title">{t('access.apps')}</h2>
      {grants.isPending ? (
        <Skeleton lines={2} />
      ) : grants.isError ? (
        <ErrorBox onRetry={() => void grants.refetch()}>{t('common.error')}</ErrorBox>
      ) : items.length ? (
        <ul className="app-list app-bordered">
          {items.map((grant) => {
            const pending = grant.status === 'pending';
            const meta = pending
              ? t('access.pendingMeta', { scopes: scopeSummary(grant.scopes, t) })
              : [
                  scopeSummary(grant.scopes, t),
                  grant.last_used_at
                    ? t('access.lastUsed', { time: relativeTime(grant.last_used_at, when) })
                    : t('access.neverUsed'),
                ].join(' · ');
            return (
              <li key={grant.id} className="app-list-row is-static">
                <span className="app-list-main">
                  <span className="app-list-title">
                    {grant.client.name}
                    {grant.client.kind === 'machine'
                      ? ` · ${t('access.machine')}`
                      : grant.client.registration === 'dynamic'
                        ? ` · ${t('access.selfRegistered')}`
                        : ''}
                  </span>
                  <span className="app-list-meta">{meta}</span>
                </span>
                {pending ? (
                  <StatusBadge status={t('status.needsYou')} tone="warning" />
                ) : (
                  grant.client.status === 'disabled' && <StatusBadge status={t('access.clientOff')} tone="neutral" />
                )}
                {pending && (
                  <Button size="sm" kind="primary" onClick={() => approve(grant)}>
                    {t('access.approve')}
                  </Button>
                )}
                <Button size="sm" kind="danger" onClick={() => setRevoking(grant)}>
                  {pending ? t('access.refuse') : t('access.revoke')}
                </Button>
              </li>
            );
          })}
        </ul>
      ) : (
        <Empty title={t('access.noApps')} />
      )}
      {revoking && (
        <ConfirmDialog
          danger
          title={
            revoking.status === 'pending'
              ? t('access.refuseTitle', { name: revoking.client.name })
              : t('access.revokeAppTitle', { name: revoking.client.name })
          }
          confirmLabel={revoking.status === 'pending' ? t('access.refuse') : t('access.revoke')}
          onCancel={() => setRevoking(null)}
          onConfirm={() => {
            const target = revoking;
            setRevoking(null);
            void api.me.grants
              .revoke(target.id)
              .then(() => refresh())
              .catch((caught: unknown) => notify(errorText(caught, t)));
          }}
        >
          {revoking.status === 'pending' ? t('access.refuseBody') : t('access.revokeAppBody')}
        </ConfirmDialog>
      )}
    </section>
  );
}

export function AccessSection() {
  return (
    <>
      <Tokens />
      <Grants />
    </>
  );
}
