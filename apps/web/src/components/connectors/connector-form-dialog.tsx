/**
 * Add or edit a connector — a team one (Administration → Connectors) or a
 * member's own (Settings → Connections). Secrets are write-only: an edit
 * shows "stored" and only sends a new value when one is typed. The server
 * validates everything again (and refuses a private address, a shared
 * credential or an internal flag on a personal connector).
 */

import React, { useMemo, useState } from 'react';
import {
  CONNECTOR_SLUG_PATTERN,
  type ConnectorAuthKind,
  type ConnectorAuthMode,
  type ConnectorCatalogEntry,
  type ConnectorInput,
  type ConnectorTransport,
  type ConnectorUpdate,
  type ConnectorView,
} from '@greenhouse/types/connectors';
import { Button, Checkbox, Dialog, Input, Select, Spinner, Textarea } from '../ui';
import { FormActions, FormError, FormField, FormGrid, FormSection } from '../form';
import { useI18n, useT } from '../../lib/i18n';
import { probeConnector } from '../../lib/api/connectors';

export type ConnectorFormScope = 'team' | 'personal';

interface Draft {
  slug: string;
  name: string;
  description: string;
  url: string;
  transport: ConnectorTransport;
  auth_mode: ConnectorAuthMode;
  auth_kind: ConnectorAuthKind;
  auth_place: 'header' | 'query';
  auth_header: string;
  auth_query_param: string;
  auth_value_prefix: string;
  shared_secret: string;
  oauth_scope: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  private_network: boolean;
  allow_external_writes: boolean;
  enabled: boolean;
  catalog_id: string | null;
}

function draftFrom(existing?: ConnectorView, entry?: ConnectorCatalogEntry, zh = false): Draft {
  if (existing) {
    return {
      slug: existing.slug,
      name: existing.name,
      description: existing.description ?? '',
      url: existing.url,
      transport: existing.transport,
      auth_mode: existing.auth_mode,
      auth_kind: existing.auth_kind ?? 'key',
      auth_place: existing.auth_query_param ? 'query' : 'header',
      auth_header: existing.auth_header ?? 'Authorization',
      auth_query_param: existing.auth_query_param ?? '',
      auth_value_prefix: existing.auth_value_prefix ?? '',
      shared_secret: '',
      oauth_scope: existing.oauth_scope ?? '',
      oauth_client_id: existing.oauth_client?.source === 'manual' ? existing.oauth_client.client_id : '',
      oauth_client_secret: '',
      private_network: existing.private_network,
      allow_external_writes: existing.allow_external_writes,
      enabled: existing.enabled,
      catalog_id: existing.catalog_id,
    };
  }
  return {
    slug: entry?.slug ?? '',
    name: entry ? ((zh ? entry.title_zh : null) ?? entry.title) : '',
    description: entry ? (zh ? entry.description_zh : entry.description) : '',
    url: entry?.url ?? '',
    transport: entry?.transport ?? 'streamable_http',
    auth_mode: entry?.auth.mode ?? 'none',
    auth_kind: entry?.auth.kind ?? 'key',
    auth_place: entry?.auth.query_param ? 'query' : 'header',
    auth_header: entry?.auth.header ?? 'Authorization',
    auth_query_param: entry?.auth.query_param ?? '',
    auth_value_prefix: entry?.auth.prefix ?? (entry?.auth.header ? '' : 'Bearer '),
    shared_secret: '',
    oauth_scope: entry?.auth.scope ?? '',
    oauth_client_id: '',
    oauth_client_secret: '',
    private_network: false,
    allow_external_writes: false,
    enabled: true,
    catalog_id: entry?.id ?? null,
  };
}

function toInput(d: Draft, scope: ConnectorFormScope): ConnectorInput {
  const key = d.auth_mode !== 'none' && d.auth_kind === 'key';
  const oauth = d.auth_mode !== 'none' && d.auth_kind === 'oauth';
  return {
    slug: d.slug.trim(),
    name: d.name.trim(),
    description: d.description.trim() || null,
    url: d.url.trim(),
    transport: d.transport,
    auth_mode: d.auth_mode,
    auth_kind: d.auth_mode === 'none' ? null : d.auth_kind,
    auth_header: key && d.auth_place === 'header' ? d.auth_header.trim() || null : null,
    auth_query_param: key && d.auth_place === 'query' ? d.auth_query_param.trim() || null : null,
    auth_value_prefix: key ? d.auth_value_prefix || null : null,
    ...(key && d.auth_mode === 'shared' && d.shared_secret ? { shared_secret: d.shared_secret } : {}),
    oauth_scope: oauth ? d.oauth_scope.trim() || null : null,
    oauth_client_id: oauth ? d.oauth_client_id.trim() || null : null,
    ...(oauth && d.oauth_client_secret ? { oauth_client_secret: d.oauth_client_secret } : {}),
    ...(scope === 'team' ? { private_network: d.private_network, allow_external_writes: d.allow_external_writes } : {}),
    enabled: d.enabled,
    catalog_id: d.catalog_id,
  };
}

export function ConnectorFormDialog({
  scope,
  existing,
  catalogEntry,
  onClose,
  onCreate,
  onUpdate,
}: {
  scope: ConnectorFormScope;
  existing?: ConnectorView;
  catalogEntry?: ConnectorCatalogEntry;
  onClose: () => void;
  onCreate: (input: ConnectorInput) => Promise<void>;
  onUpdate: (id: string, patch: ConnectorUpdate) => Promise<void>;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [draft, setDraft] = useState<Draft>(() => draftFrom(existing, catalogEntry, locale === 'zh'));
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const slugOk = existing || CONNECTOR_SLUG_PATTERN.test(draft.slug.trim());
  const canSave = Boolean(draft.name.trim() && draft.url.trim() && slugOk) && !saving;
  const authModes = useMemo<ConnectorAuthMode[]>(
    () => (scope === 'team' ? ['none', 'shared', 'per_member'] : ['none', 'per_member']),
    [scope],
  );
  const hasCredential = draft.auth_mode !== 'none';
  const keyAuth = hasCredential && draft.auth_kind === 'key';
  const oauthAuth = hasCredential && draft.auth_kind === 'oauth';
  const help = catalogEntry ? ((locale === 'zh' ? catalogEntry.auth.help_zh : null) ?? catalogEntry.auth.help) : null;

  const probe = async () => {
    setProbing(true);
    setProbeNote(null);
    try {
      const result = await probeConnector({
        url: draft.url.trim(),
        transport: draft.transport,
        private_network: draft.private_network,
      });
      if (result.auth === 'none') {
        setDraft((d) => ({ ...d, auth_mode: 'none' }));
        setProbeNote(t('connectors.probeNone', { count: result.tool_count ?? 0 }));
      } else if (result.auth === 'oauth') {
        setDraft((d) => ({ ...d, auth_mode: d.auth_mode === 'none' ? 'per_member' : d.auth_mode, auth_kind: 'oauth' }));
        setProbeNote(
          result.dynamic_registration || result.metadata_document
            ? t('connectors.probeOauth')
            : t('connectors.probeOauthManual'),
        );
      } else if (result.auth === 'key') {
        setDraft((d) => ({ ...d, auth_mode: d.auth_mode === 'none' ? 'per_member' : d.auth_mode, auth_kind: 'key' }));
        setProbeNote(t('connectors.probeKey'));
      } else {
        setProbeNote(t('connectors.probeUnknown', { error: result.error ?? '' }));
      }
    } catch (err) {
      setProbeNote(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const input = toInput(draft, scope);
      if (existing) {
        const { slug: _slug, ...patch } = input;
        await onUpdate(existing.id, patch);
      } else {
        await onCreate(input);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const title = existing
    ? t('connectors.editTitle', { name: existing.name })
    : scope === 'team'
      ? t('connectors.addTeamTitle')
      : t('connectors.addPersonalTitle');

  return (
    <Dialog open onClose={onClose} title={title} size="lg">
      <div className="space-y-4" data-testid="connector-form">
        <FormGrid>
          <FormField label={t('connectors.field.name')} required>
            <Input
              value={draft.name}
              onChange={(e) => set('name', e.target.value)}
              data-testid="connector-field-name"
            />
          </FormField>
          <FormField
            label={t('connectors.field.slug')}
            required
            help={t('connectors.field.slugHelp')}
            error={!existing && draft.slug && !slugOk ? t('connectors.field.slugInvalid') : undefined}
          >
            <Input
              value={draft.slug}
              disabled={Boolean(existing)}
              onChange={(e) => set('slug', e.target.value.toLowerCase())}
              data-testid="connector-field-slug"
            />
          </FormField>
        </FormGrid>
        <FormField label={t('connectors.field.description')} help={t('connectors.field.descriptionHelp')}>
          <Textarea rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} />
        </FormField>
        <FormGrid>
          <FormField label={t('connectors.field.url')} required>
            <Input
              value={draft.url}
              placeholder="https://example.com/mcp"
              onChange={(e) => set('url', e.target.value)}
              data-testid="connector-field-url"
            />
          </FormField>
          <FormField label={t('connectors.field.transport')}>
            <Select value={draft.transport} onChange={(e) => set('transport', e.target.value as ConnectorTransport)}>
              <option value="streamable_http">{t('connectors.transport.streamable_http')}</option>
              <option value="sse">{t('connectors.transport.sse')}</option>
            </Select>
          </FormField>
        </FormGrid>
        {scope === 'team' && (
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" disabled={!draft.url.trim() || probing} onClick={probe}>
              {probing && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
              {t('connectors.probe')}
            </Button>
            {probeNote && <span className="text-xs text-fg-muted">{probeNote}</span>}
          </div>
        )}

        <FormSection title={t('connectors.section.auth')}>
          {help && <p className="mb-3 text-xs text-fg-muted">{help}</p>}
          <FormGrid>
            <FormField label={t('connectors.field.authMode')}>
              <Select
                value={draft.auth_mode}
                onChange={(e) => set('auth_mode', e.target.value as ConnectorAuthMode)}
                data-testid="connector-field-auth-mode"
              >
                {authModes.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`connectors.authMode.${mode}`)}
                  </option>
                ))}
              </Select>
            </FormField>
            {hasCredential && (
              <FormField label={t('connectors.field.authKind')}>
                <Select value={draft.auth_kind} onChange={(e) => set('auth_kind', e.target.value as ConnectorAuthKind)}>
                  <option value="key">{t('connectors.authKind.key')}</option>
                  <option value="oauth">{t('connectors.authKind.oauth')}</option>
                </Select>
              </FormField>
            )}
          </FormGrid>
          {keyAuth && (
            <FormGrid columns={3} className="mt-3">
              <FormField label={t('connectors.field.keyPlace')}>
                <Select
                  value={draft.auth_place}
                  onChange={(e) => set('auth_place', e.target.value as Draft['auth_place'])}
                >
                  <option value="header">{t('connectors.keyPlace.header')}</option>
                  <option value="query">{t('connectors.keyPlace.query')}</option>
                </Select>
              </FormField>
              {draft.auth_place === 'header' ? (
                <FormField label={t('connectors.field.header')}>
                  <Input value={draft.auth_header} onChange={(e) => set('auth_header', e.target.value)} />
                </FormField>
              ) : (
                <FormField label={t('connectors.field.queryParam')}>
                  <Input value={draft.auth_query_param} onChange={(e) => set('auth_query_param', e.target.value)} />
                </FormField>
              )}
              <FormField label={t('connectors.field.prefix')} help={t('connectors.field.prefixHelp')}>
                <Input value={draft.auth_value_prefix} onChange={(e) => set('auth_value_prefix', e.target.value)} />
              </FormField>
            </FormGrid>
          )}
          {keyAuth && draft.auth_mode === 'shared' && (
            <FormField
              className="mt-3"
              label={t('connectors.field.sharedKey')}
              help={existing?.has_shared_secret ? t('connectors.field.secretStored') : undefined}
            >
              <Input
                type="password"
                autoComplete="off"
                value={draft.shared_secret}
                onChange={(e) => set('shared_secret', e.target.value)}
                data-testid="connector-field-shared-secret"
              />
            </FormField>
          )}
          {oauthAuth && (
            <FormGrid columns={3} className="mt-3">
              <FormField label={t('connectors.field.oauthScope')}>
                <Input value={draft.oauth_scope} onChange={(e) => set('oauth_scope', e.target.value)} />
              </FormField>
              <FormField label={t('connectors.field.oauthClientId')} help={t('connectors.field.oauthClientHelp')}>
                <Input value={draft.oauth_client_id} onChange={(e) => set('oauth_client_id', e.target.value)} />
              </FormField>
              <FormField
                label={t('connectors.field.oauthClientSecret')}
                help={existing?.oauth_client?.has_secret ? t('connectors.field.secretStored') : undefined}
              >
                <Input
                  type="password"
                  autoComplete="off"
                  value={draft.oauth_client_secret}
                  onChange={(e) => set('oauth_client_secret', e.target.value)}
                />
              </FormField>
            </FormGrid>
          )}
        </FormSection>

        <FormSection title={t('connectors.section.access')}>
          <div className="space-y-2">
            {existing && (
              <Checkbox
                label={t('connectors.field.enabled')}
                checked={draft.enabled}
                onChange={(e) => set('enabled', e.target.checked)}
              />
            )}
            {scope === 'team' && (
              <>
                <Checkbox
                  label={t('connectors.field.privateNetwork')}
                  checked={draft.private_network}
                  onChange={(e) => set('private_network', e.target.checked)}
                />
                <p className="pl-6 text-caption text-fg-faint">{t('connectors.field.privateNetworkHelp')}</p>
                <Checkbox
                  label={t('connectors.field.externalWrites')}
                  checked={draft.allow_external_writes}
                  onChange={(e) => set('allow_external_writes', e.target.checked)}
                />
                <p className="pl-6 text-caption text-fg-faint">{t('connectors.field.externalWritesHelp')}</p>
              </>
            )}
            {existing && (existing.url !== draft.url.trim() || existing.auth_mode !== draft.auth_mode) && (
              <p className="text-xs text-warning">{t('connectors.dropsCredentials')}</p>
            )}
          </div>
        </FormSection>

        {error && <FormError>{error}</FormError>}
        <FormActions>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button size="sm" disabled={!canSave} onClick={save} data-testid="connector-form-submit">
            {saving && <Spinner className="mr-1.5 h-3.5 w-3.5" />}
            {existing ? t('common.save') : t('connectors.add')}
          </Button>
        </FormActions>
      </div>
    </Dialog>
  );
}
