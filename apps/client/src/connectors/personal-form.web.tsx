/**
 * Add or edit one of my own connectors (browser, an `lg` dialog): name, handle (`me/<slug>`, fixed
 * once created), address, transport and how it signs in — nothing, my key (header or query
 * parameter) or my sign-in (OAuth; a hand-registered client when the server has no dynamic
 * registration). My key itself is added afterwards from the row (Add My Key), never here. Rules in
 * ./personal-draft.ts; changing the address or the sign-in forgets my connection (server-side).
 */
import React, { useState } from 'react';
import { createPersonalConnector, updatePersonalConnector, type PersonalConnector } from '../api/connectors';
import { useT } from '../lib/i18n';
import { toast } from '../ui/toast';
import { AdminDialog, Callout, Field } from '../admin/kit.web';
import { useWrite } from '../admin/use-write';
import {
  dropsMyConnection,
  personalDraft,
  personalInput,
  personalReady,
  personalUpdate,
  PERSONAL_SLUG_PATTERN,
  type PersonalDraft,
} from './personal-draft';

export function PersonalConnectorDialog({
  existing,
  close,
  saved,
}: {
  existing?: PersonalConnector;
  close: () => void;
  saved: () => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<PersonalDraft>(() => personalDraft(existing));
  const { busy, run } = useWrite();
  const set = <K extends keyof PersonalDraft>(key: K, value: PersonalDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const ready = personalReady(draft, !!existing);
  const save = async () => {
    if (!ready) return;
    const answer = await run(
      () =>
        existing
          ? updatePersonalConnector(existing.id, personalUpdate(draft))
          : createPersonalConnector(personalInput(draft)),
      t('connectors.saveFailed'),
    );
    if (!answer) return;
    toast(existing ? t('connectors.savedOwn') : t('connectors.addedOwn', { name: answer.name }), 'check');
    saved();
    close();
  };
  const input =
    (key: keyof PersonalDraft, props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    (id: string) => (
      <input id={id} value={String(draft[key])} onChange={(e) => set(key, e.target.value as never)} {...props} />
    );
  return (
    <AdminDialog
      size="lg"
      title={existing ? t('connectors.editOwnTitle', { name: existing.name }) : t('connectors.addOwnTitle')}
      onClose={close}
      testID="personal-connector-form"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="personal-connector" className="gh-primary" disabled={busy || !ready}>
            {existing ? t('common.save') : t('connectors.addOwn')}
          </button>
        </>
      }
    >
      <form
        id="personal-connector"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="gh-hint">{t('connectors.ownIntro')}</p>
        <div className="gh-form-grid">
          <Field label={t('connectors.field.name')} required>
            {input('name', { placeholder: t('connectors.field.namePlaceholder') })}
          </Field>
          <Field
            label={t('connectors.field.slug')}
            required
            help={t('connectors.field.slugHint')}
            error={
              !existing && draft.slug && !PERSONAL_SLUG_PATTERN.test(draft.slug.trim())
                ? t('connectors.field.slugInvalid')
                : null
            }
          >
            {(id) => (
              <input
                id={id}
                value={draft.slug}
                disabled={!!existing}
                onChange={(e) => set('slug', e.target.value.toLowerCase())}
              />
            )}
          </Field>
        </div>
        <Field label={t('connectors.field.description')} help={t('connectors.field.descriptionHint')}>
          {(id) => (
            <textarea id={id} rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} />
          )}
        </Field>
        <div className="gh-form-grid">
          <Field label={t('connectors.field.url')} required>
            {input('url', { placeholder: 'https://example.com/mcp', inputMode: 'url' })}
          </Field>
          <Field label={t('connectors.field.transport')}>
            {(id) => (
              <select
                id={id}
                value={draft.transport}
                onChange={(e) => set('transport', e.target.value as PersonalDraft['transport'])}
              >
                <option value="streamable_http">Streamable HTTP</option>
                <option value="sse">{t('connectors.field.sse')}</option>
              </select>
            )}
          </Field>
        </div>
        <h4 className="gh-form-heading">{t('connectors.field.signIn')}</h4>
        <Field label={t('connectors.field.auth')} help={t(`connectors.field.authHint.${draft.auth}`)}>
          {(id) => (
            <select id={id} value={draft.auth} onChange={(e) => set('auth', e.target.value as PersonalDraft['auth'])}>
              {(['none', 'key', 'oauth'] as const).map((auth) => (
                <option key={auth} value={auth}>
                  {t(`connectors.field.authKind.${auth}`)}
                </option>
              ))}
            </select>
          )}
        </Field>
        {draft.auth === 'key' ? (
          <div className="gh-form-grid">
            <Field label={t('connectors.field.keyPlace')}>
              {(id) => (
                <select
                  id={id}
                  value={draft.key_place}
                  onChange={(e) => set('key_place', e.target.value as PersonalDraft['key_place'])}
                >
                  <option value="header">{t('connectors.field.header')}</option>
                  <option value="query">{t('connectors.field.queryParam')}</option>
                </select>
              )}
            </Field>
            {draft.key_place === 'header' ? (
              <Field label={t('connectors.field.header')}>{input('auth_header')}</Field>
            ) : (
              <Field label={t('connectors.field.queryParam')}>{input('auth_query_param')}</Field>
            )}
            <Field label={t('connectors.field.prefix')} help={t('connectors.field.prefixHint')}>
              {input('auth_value_prefix')}
            </Field>
          </div>
        ) : null}
        {draft.auth === 'oauth' ? (
          <div className="gh-form-grid">
            <Field label={t('connectors.field.oauthScope')}>{input('oauth_scope')}</Field>
            <Field label={t('connectors.field.clientId')} help={t('connectors.field.clientIdHint')}>
              {input('oauth_client_id')}
            </Field>
            <Field
              label={t('connectors.field.clientSecret')}
              help={existing?.oauth_client?.has_secret ? t('connectors.field.secretStored') : undefined}
            >
              {input('oauth_client_secret', { type: 'password', autoComplete: 'off' })}
            </Field>
          </div>
        ) : null}
        {existing && dropsMyConnection(existing, draft) ? <Callout>{t('connectors.dropsConnection')}</Callout> : null}
      </form>
    </AdminDialog>
  );
}
