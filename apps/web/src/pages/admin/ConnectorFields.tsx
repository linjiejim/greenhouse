/**
 * A connector's settings as form fields, shared by installing from an address and editing: name,
 * slug (fixed once installed), description, address, auth mode and what that mode needs. A key
 * typed here goes out once with the form; afterwards keys are write-only (the drawer's 密钥).
 */

import { Field, FieldGroup, Input, Segmented, Select, TextArea } from '@greenhouse/ui/kit';
import { CONNECTOR_AUTH_MODES, type Connector, type ConnectorAuthMode } from '@greenhouse/contract';
import type { MessageKey } from '../../i18n/zh';
import { useI18n } from '../../lib/i18n';
import { carriesKey, type ConnectorDraft, type KeyPlace } from './connector-draft';

export const MODE_LABEL: Record<ConnectorAuthMode, MessageKey> = {
  none: 'connectors.mode.none',
  shared: 'connectors.mode.shared',
  per_member: 'connectors.mode.per_member',
  oauth: 'connectors.mode.oauth',
};

const MODE_HINT: Record<ConnectorAuthMode, MessageKey> = {
  none: 'connectors.modeHint.none',
  shared: 'connectors.modeHint.shared',
  per_member: 'connectors.modeHint.per_member',
  oauth: 'connectors.modeHint.oauth',
};

/** Where a provider sends a member back after signing in, for an OAuth app an admin registers by hand. */
export const callbackAddress = () => `${location.origin}/api/connectors/oauth/callback`;

export type DraftError = { field: keyof ConnectorDraft; text: string } | null;

export function TransportField({
  value,
  onChange,
}: {
  value: Connector['transport'];
  onChange: (value: Connector['transport']) => void;
}) {
  const { t } = useI18n();
  return (
    <FieldGroup label={t('connectors.transport')}>
      <Select
        label={t('connectors.transport')}
        value={value}
        options={[
          { value: 'streamable_http', label: 'Streamable HTTP' },
          { value: 'sse', label: t('connectors.transportSse') },
        ]}
        onChange={(next) => onChange(next as Connector['transport'])}
      />
    </FieldGroup>
  );
}

export function ConnectorFields({
  draft,
  set,
  connector,
  error,
}: {
  draft: ConnectorDraft;
  set: (patch: Partial<ConnectorDraft>) => void;
  /** The connector being edited: its slug is fixed and its address is part of the form. */
  connector?: Connector;
  error: DraftError;
}) {
  const { t } = useI18n();
  const errorOf = (field: keyof ConnectorDraft) => (error?.field === field ? error.text : undefined);
  const newKeyNeeded = draft.auth_mode === 'shared' && connector?.auth_mode !== 'shared';
  return (
    <>
      <Field label={t('connectors.name')} required error={errorOf('name')}>
        <Input value={draft.name} maxLength={80} onChange={(event) => set({ name: event.target.value })} />
      </Field>
      {connector ? (
        <Field label={t('connectors.slug')} description={t('connectors.slugFixed')}>
          <Input value={draft.slug} readOnly />
        </Field>
      ) : (
        <Field label={t('connectors.slug')} required description={t('connectors.slugHint')} error={errorOf('slug')}>
          <Input value={draft.slug} maxLength={32} onChange={(event) => set({ slug: event.target.value })} />
        </Field>
      )}
      <Field label={t('connectors.description')} description={t('connectors.descriptionHint')}>
        <TextArea
          value={draft.description}
          maxLength={500}
          maxRows={4}
          onChange={(event) => set({ description: event.target.value })}
        />
      </Field>
      {connector && (
        <>
          <Field
            label={t('connectors.url')}
            required
            error={errorOf('url')}
            description={connector.connection_count ? t('connectors.urlDisconnects') : undefined}
          >
            <Input value={draft.url} onChange={(event) => set({ url: event.target.value })} />
          </Field>
          <TransportField value={draft.transport} onChange={(transport) => set({ transport })} />
        </>
      )}
      <FieldGroup label={t('connectors.authMode')}>
        <Select
          label={t('connectors.authMode')}
          value={draft.auth_mode}
          options={CONNECTOR_AUTH_MODES.map((mode) => ({
            value: mode,
            label: t(MODE_LABEL[mode]),
            description: t(MODE_HINT[mode]),
          }))}
          onChange={(mode) => set({ auth_mode: mode as ConnectorAuthMode })}
        />
      </FieldGroup>
      {carriesKey(draft.auth_mode) && (
        <>
          <FieldGroup label={t('connectors.keyPlace')}>
            <Segmented
              label={t('connectors.keyPlace')}
              items={[
                { value: 'header', label: t('connectors.header') },
                { value: 'query', label: t('connectors.query') },
              ]}
              value={draft.place}
              onChange={(place) => set({ place: place as KeyPlace })}
            />
          </FieldGroup>
          <div className="app-form-row">
            {draft.place === 'header' ? (
              <Field label={t('connectors.headerName')} required error={errorOf('header')}>
                <Input value={draft.header} maxLength={64} onChange={(event) => set({ header: event.target.value })} />
              </Field>
            ) : (
              <Field label={t('connectors.queryName')} required error={errorOf('query')}>
                <Input value={draft.query} maxLength={64} onChange={(event) => set({ query: event.target.value })} />
              </Field>
            )}
            <Field label={t('connectors.prefix')} description={t('connectors.prefixHint')} error={errorOf('prefix')}>
              <Input value={draft.prefix} maxLength={32} onChange={(event) => set({ prefix: event.target.value })} />
            </Field>
          </div>
        </>
      )}
      {newKeyNeeded && (
        <Field
          label={t('connectors.sharedKey')}
          required
          description={t('connectors.sharedKeyHint')}
          error={errorOf('shared_key')}
        >
          <Input
            type="password"
            autoComplete="off"
            value={draft.shared_key}
            onChange={(event) => set({ shared_key: event.target.value })}
          />
        </Field>
      )}
      {draft.auth_mode === 'per_member' && (
        <>
          <Field label={t('connectors.keyHelp')} description={t('connectors.keyHelpHint')}>
            <TextArea
              value={draft.key_help}
              maxLength={500}
              maxRows={4}
              onChange={(event) => set({ key_help: event.target.value })}
            />
          </Field>
          <Field label={t('connectors.keyHelpUrl')} error={errorOf('key_help_url')}>
            <Input
              value={draft.key_help_url}
              placeholder="https://"
              onChange={(event) => set({ key_help_url: event.target.value })}
            />
          </Field>
        </>
      )}
      {draft.auth_mode === 'oauth' && (
        <>
          <Field label={t('connectors.oauthScope')} description={t('connectors.oauthScopeHint')}>
            <Input
              value={draft.oauth_scope}
              maxLength={512}
              onChange={(event) => set({ oauth_scope: event.target.value })}
            />
          </Field>
          {connector?.oauth_client?.source === 'dynamic' ? (
            <p className="app-muted">{t('connectors.oauthDynamic', { id: connector.oauth_client.client_id })}</p>
          ) : (
            <Field
              label={t('connectors.oauthClientId')}
              description={t('connectors.oauthClientIdHint', { callback: callbackAddress() })}
            >
              <Input
                value={draft.oauth_client_id}
                maxLength={512}
                onChange={(event) => set({ oauth_client_id: event.target.value })}
              />
            </Field>
          )}
          {!connector && draft.oauth_client_id.trim() && (
            <Field label={t('connectors.oauthClientSecret')} description={t('connectors.oauthClientSecretHint')}>
              <Input
                type="password"
                autoComplete="off"
                value={draft.oauth_client_secret}
                onChange={(event) => set({ oauth_client_secret: event.target.value })}
              />
            </Field>
          )}
        </>
      )}
    </>
  );
}
