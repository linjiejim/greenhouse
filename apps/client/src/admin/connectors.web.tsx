/**
 * Team connectors (/api/admin/connectors): the outside services (MCP servers) the team's agents
 * reach through `mcp_call`. Add one by address (Check address says how it signs in) or from the
 * official catalog; choose who signs in (nobody, a team credential, each member's own); switch
 * tools (reads on, writes off until switched on, destructive ones preview); refresh; delete.
 * Changing the address or the sign-in method drops every member's credential (server-side).
 */
import React, { useCallback, useState } from 'react';
import { del, get, patch, post, seg } from '../api/client';
import { useResource } from '../data/use-resource';
import { getApiBase } from '../store/stations';
import { usePrefs } from '../store/prefs';
import { useT, localeOf, type TFunction } from '../lib/i18n';
import { Icon } from '../ui/core';
import { confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import { AdminDialog, AdminPage, Badge, Callout, Field, SectionState, Switch, type Tone } from './kit.web';
import { useWrite } from './use-write';
import { dateTimeLabel } from './format';
import {
  connectorInput,
  draftFrom,
  draftReady,
  dropsCredentials,
  toolKind,
  toolPolicy,
  type CatalogEntry,
  type ConnectorTool,
  type Draft,
  type ProbeResult,
  type TeamConnector,
} from './connectors-model';

const BASE = '/api/admin/connectors';
const KIND_TONE: Record<'read' | 'write' | 'destructive', Tone> = {
  read: 'success',
  write: 'warning',
  destructive: 'danger',
};
const STATUS_TONE: Record<string, Tone> = { connected: 'success', needs_reauth: 'warning', error: 'danger' };

type Editing =
  | { kind: 'form'; connector?: TeamConnector; entry?: CatalogEntry }
  | { kind: 'tools'; connector: TeamConnector }
  | { kind: 'catalog' };

/** Team OAuth sign-in in a popup, which the station's finish page closes with a message (as on classic). */
function signInPopup(name: string, start: () => Promise<string | null>): Promise<'connected' | 'failed' | 'closed'> {
  const popup = window.open('', `greenhouse-connector-${name}`, 'popup,width=560,height=720');
  return start().then((url) => {
    if (!url) {
      popup?.close();
      return 'failed';
    }
    if (!popup) {
      window.location.href = url;
      return 'closed';
    }
    popup.location.href = url;
    const origin = new URL(getApiBase()).origin;
    return new Promise((resolve) => {
      const finish = (outcome: 'connected' | 'failed' | 'closed') => {
        window.removeEventListener('message', onMessage);
        window.clearInterval(watch);
        resolve(outcome);
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== popup || event.origin !== origin) return;
        const data = event.data as { type?: string; ok?: boolean } | null;
        if (data?.type === 'greenhouse:connector') finish(data.ok ? 'connected' : 'failed');
      };
      window.addEventListener('message', onMessage);
      const watch = window.setInterval(() => popup.closed && finish('closed'), 500);
    });
  });
}

const authLabel = (c: { auth_mode: string; auth_kind: string | null }, t: TFunction) =>
  [
    t(`admin.connectors.authMode.${c.auth_mode as 'none' | 'shared' | 'per_member'}`),
    ...(c.auth_kind && c.auth_mode !== 'none'
      ? [t(`admin.connectors.authKind.${c.auth_kind as 'key' | 'oauth'}`)]
      : []),
  ].join(' · ');

export default function ConnectorsSection() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const list = useResource(useCallback(() => get<{ connectors: TeamConnector[] }>(BASE), []));
  const [editing, setEditing] = useState<Editing | null>(null);
  const { busy, run } = useWrite();
  const reload = () => void list.refresh();
  const refresh = async (c: TeamConnector) => {
    const answer = await run(
      () => post<{ ok: boolean; error: string | null; connector: TeamConnector }>(`${BASE}/${seg(c.id)}/refresh`),
      t('admin.connectors.refreshFailed'),
    );
    if (!answer) return;
    toast(
      answer.ok
        ? t('admin.connectors.refreshed', { n: answer.connector.tools.length })
        : t('admin.connectors.refreshFailed'),
    );
    reload();
  };
  const teamSignIn = async (c: TeamConnector) => {
    const outcome = await signInPopup(c.id, async () => {
      const r = await post<{ authorize_url: string }>(`${BASE}/${seg(c.id)}/oauth/start`, { client: 'web' });
      return r.ok ? r.data.authorize_url : null;
    });
    if (outcome === 'connected') toast(t('admin.connectors.signedIn', { name: c.name }));
    else if (outcome === 'failed') toast(t('admin.connectors.signInFailed'));
    reload();
  };
  const teamSignOut = async (c: TeamConnector) => {
    if (await run(() => del(`${BASE}/${seg(c.id)}/oauth`), t('admin.connectors.actionFailed'))) reload();
  };
  const remove = async (c: TeamConnector) => {
    const ok = await confirmAction({
      title: t('admin.connectors.deleteTitle', { name: c.name }),
      message: t('admin.connectors.deleteHint'),
      confirmLabel: t('admin.connectors.delete'),
      destructive: true,
    });
    if (!ok) return;
    if (await run(() => del(`${BASE}/${seg(c.id)}`), t('admin.connectors.actionFailed'))) {
      toast(t('admin.connectors.deleted', { name: c.name }));
      reload();
    }
  };
  const connectors = list.data?.connectors;
  return (
    <AdminPage
      title={t('admin.sections.connectors')}
      testID="admin-connectors"
      actions={
        <>
          <button className="gh-icon-button" aria-label={t('common.refresh')} disabled={list.loading} onClick={reload}>
            <Icon name="refresh" size={16} />
          </button>
          <button className="gh-secondary-button" onClick={() => setEditing({ kind: 'catalog' })}>
            <Icon name="book" size={14} />
            {t('admin.connectors.fromCatalog')}
          </button>
          <button className="gh-primary" onClick={() => setEditing({ kind: 'form' })}>
            {t('admin.connectors.add')}
          </button>
        </>
      }
    >
      <p className="gh-hint">{t('admin.connectors.intro')}</p>
      {connectors?.length ? (
        <table className="gh-data-grid gh-admin-grid">
          <thead>
            <tr>
              <th>{t('admin.connectors.name')}</th>
              <th>{t('admin.connectors.signIn')}</th>
              <th>{t('admin.connectors.tools')}</th>
              <th>{t('admin.metering.status')}</th>
              <th>{t('admin.connectors.listed')}</th>
              <th aria-label={t('admin.actions')} />
            </tr>
          </thead>
          <tbody>
            {connectors.map((c) => {
              const on = c.tools.filter((tool) => tool.enabled);
              const writes = on.filter((tool) => tool.kind !== 'read').length;
              const teamOAuth = c.auth_mode === 'shared' && c.auth_kind === 'oauth';
              return (
                <tr key={c.id} data-muted={c.enabled ? undefined : ''} data-testid={`connector-${c.slug}`}>
                  <td title={c.url}>
                    <strong>{c.name}</strong>
                    <span className="gh-admin-sub gh-mono">{c.handle}</span>
                  </td>
                  <td>
                    <span className="gh-chip-row">
                      <Badge tone="info">{authLabel(c, t)}</Badge>
                      {c.private_network ? <Badge tone="warning">{t('admin.connectors.internal')}</Badge> : null}
                      {c.allow_external_writes ? (
                        <Badge tone="warning">{t('admin.connectors.externalWrites')}</Badge>
                      ) : null}
                    </span>
                  </td>
                  <td>{t('admin.connectors.toolSummary', { on: on.length, total: c.tools.length, writes })}</td>
                  <td>
                    <span className="gh-chip-row">
                      {!c.enabled ? <Badge>{t('admin.connectors.off')}</Badge> : null}
                      {c.auth_mode === 'shared' && !c.has_shared_secret ? (
                        <Badge tone="danger">{t('admin.connectors.noTeamCredential')}</Badge>
                      ) : null}
                      {c.auth_mode === 'per_member' ? (
                        <Badge>{t('admin.connectors.connections', { n: c.connection_count })}</Badge>
                      ) : c.status !== 'not_needed' ? (
                        <Badge tone={STATUS_TONE[c.status] ?? 'neutral'}>
                          {t(`admin.connectors.status.${c.status}`)}
                        </Badge>
                      ) : null}
                      {c.last_error ? (
                        <Badge tone="danger" title={c.last_error}>
                          {t('admin.connectors.error')}
                        </Badge>
                      ) : null}
                    </span>
                  </td>
                  <td>{dateTimeLabel(c.tools_refreshed_at, localeOf(lang)) ?? '—'}</td>
                  <td className="gh-admin-actions">
                    {teamOAuth ? (
                      c.has_shared_secret ? (
                        <button className="gh-link-button" disabled={busy} onClick={() => void teamSignOut(c)}>
                          {t('admin.connectors.teamSignOut')}
                        </button>
                      ) : (
                        <button className="gh-link-button" disabled={busy} onClick={() => void teamSignIn(c)}>
                          {t('admin.connectors.teamSignIn')}
                        </button>
                      )
                    ) : null}
                    <button className="gh-link-button" onClick={() => setEditing({ kind: 'tools', connector: c })}>
                      {t('admin.connectors.tools')}
                    </button>
                    <button
                      className="gh-icon-button"
                      aria-label={t('admin.connectors.refreshNamed', { name: c.name })}
                      disabled={busy}
                      onClick={() => void refresh(c)}
                    >
                      <Icon name="refresh" size={15} />
                    </button>
                    <button
                      className="gh-icon-button"
                      aria-label={t('admin.connectors.editNamed', { name: c.name })}
                      onClick={() => setEditing({ kind: 'form', connector: c })}
                    >
                      <Icon name="pen" size={15} />
                    </button>
                    <button
                      className="gh-icon-button"
                      aria-label={t('admin.connectors.deleteNamed', { name: c.name })}
                      disabled={busy}
                      onClick={() => void remove(c)}
                    >
                      <Icon name="trash" size={15} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <SectionState
          loading={list.loading && !list.data}
          error={list.error}
          retry={reload}
          icon="plug"
          title={t('admin.connectors.empty')}
          message={t('admin.connectors.emptyHint')}
          action={
            <button className="gh-primary" onClick={() => setEditing({ kind: 'form' })}>
              {t('admin.connectors.add')}
            </button>
          }
        />
      )}
      {editing?.kind === 'catalog' ? (
        <CatalogDialog close={() => setEditing(null)} pick={(entry) => setEditing({ kind: 'form', entry })} />
      ) : editing?.kind === 'form' ? (
        <ConnectorForm
          existing={editing.connector}
          entry={editing.entry}
          close={() => setEditing(null)}
          saved={reload}
        />
      ) : editing?.kind === 'tools' ? (
        <ToolsDialog connector={editing.connector} close={() => setEditing(null)} saved={reload} />
      ) : null}
    </AdminPage>
  );
}

function CatalogDialog({ close, pick }: { close: () => void; pick: (entry: CatalogEntry) => void }) {
  const t = useT();
  const zh = usePrefs((s) => s.lang) === 'zh';
  const catalog = useResource(useCallback(() => get<{ entries: CatalogEntry[] }>(`${BASE}/catalog`), []));
  return (
    <AdminDialog size="lg" title={t('admin.connectors.catalogTitle')} onClose={close} testID="admin-connector-catalog">
      <div className="gh-form">
        <p className="gh-hint">{t('admin.connectors.catalogHint')}</p>
        {!catalog.data ? (
          <SectionState loading={catalog.loading} error={catalog.error} retry={() => void catalog.refresh()} />
        ) : (
          <table className="gh-data-grid gh-admin-grid">
            <tbody>
              {catalog.data.entries.map((entry) => (
                <tr key={entry.id}>
                  <td className="gh-admin-wrap">
                    <strong>{(zh ? entry.title_zh : null) ?? entry.title}</strong>
                    <span className="gh-admin-sub">{zh ? entry.description_zh : entry.description}</span>
                  </td>
                  <td>
                    <span className="gh-chip-row">
                      <Badge tone="info">
                        {authLabel({ auth_mode: entry.auth.mode, auth_kind: entry.auth.kind }, t)}
                      </Badge>
                      {entry.installed_slug ? <Badge tone="success">{t('admin.connectors.installed')}</Badge> : null}
                    </span>
                  </td>
                  <td className="gh-admin-actions">
                    <button
                      className="gh-link-button"
                      disabled={!!entry.installed_slug}
                      onClick={() => pick(entry)}
                      data-testid={`catalog-add-${entry.slug}`}
                    >
                      {t('admin.connectors.addOne')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </AdminDialog>
  );
}

function ConnectorForm({
  existing,
  entry,
  close,
  saved,
}: {
  existing?: TeamConnector;
  entry?: CatalogEntry;
  close: () => void;
  saved: () => void;
}) {
  const t = useT();
  const zh = usePrefs((s) => s.lang) === 'zh';
  const [draft, setDraft] = useState<Draft>(() => draftFrom(existing, entry, zh));
  const [probeNote, setProbeNote] = useState<string | null>(null);
  const { busy, run } = useWrite();
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const credential = draft.auth_mode !== 'none';
  const keyAuth = credential && draft.auth_kind === 'key';
  const oauthAuth = credential && draft.auth_kind === 'oauth';
  const help = entry ? ((zh ? entry.auth.help_zh : null) ?? entry.auth.help) : null;
  const probe = async () => {
    setProbeNote(null);
    const result = await run(
      () =>
        post<ProbeResult>(`${BASE}/probe`, {
          url: draft.url.trim(),
          transport: draft.transport,
          private_network: draft.private_network,
        }),
      t('admin.connectors.probeFailed'),
    );
    if (!result) return;
    if (result.auth === 'none') {
      set('auth_mode', 'none');
      setProbeNote(t('admin.connectors.probeNone', { n: result.tool_count ?? 0 }));
    } else if (result.auth === 'oauth' || result.auth === 'key') {
      const kind = result.auth;
      setDraft((d) => ({ ...d, auth_mode: d.auth_mode === 'none' ? 'per_member' : d.auth_mode, auth_kind: kind }));
      setProbeNote(
        kind === 'key'
          ? t('admin.connectors.probeKey')
          : result.dynamic_registration || result.metadata_document
            ? t('admin.connectors.probeOauth')
            : t('admin.connectors.probeOauthManual'),
      );
    } else setProbeNote(t('admin.connectors.probeUnknown', { error: result.error ?? '' }));
  };
  const save = async () => {
    if (!draftReady(draft, !!existing)) return;
    const { slug: _slug, ...update } = connectorInput(draft);
    const answer = await run(
      () =>
        existing
          ? patch<TeamConnector>(`${BASE}/${seg(existing.id)}`, update)
          : post<TeamConnector>(BASE, connectorInput(draft)),
      t('admin.saveFailed'),
    );
    if (!answer) return;
    toast(
      existing
        ? t('admin.saved')
        : answer.last_error
          ? t('admin.connectors.addedWithError', { name: answer.name })
          : t('admin.connectors.added', { name: answer.name, n: answer.tools.length }),
    );
    saved();
    close();
  };
  const input =
    (key: keyof Draft, props: React.InputHTMLAttributes<HTMLInputElement> = {}) =>
    (id: string) => (
      <input id={id} value={String(draft[key] ?? '')} onChange={(e) => set(key, e.target.value as never)} {...props} />
    );
  return (
    <AdminDialog
      size="lg"
      title={existing ? t('admin.connectors.editTitle', { name: existing.name }) : t('admin.connectors.addTitle')}
      onClose={close}
      testID="admin-connector-form"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            form="admin-connector"
            className="gh-primary"
            disabled={busy || !draftReady(draft, !!existing)}
          >
            {existing ? t('common.save') : t('admin.connectors.addOne')}
          </button>
        </>
      }
    >
      <form
        id="admin-connector"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="gh-form-grid">
          <Field label={t('admin.connectors.name')} required>
            {input('name')}
          </Field>
          <Field
            label={t('admin.connectors.slug')}
            required
            help={t('admin.connectors.slugHint')}
            error={
              !existing && draft.slug && !draftReady({ ...draft, name: 'x', url: 'x' }, false)
                ? t('admin.connectors.slugInvalid')
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
        <Field label={t('admin.connectors.description')} help={t('admin.connectors.descriptionHint')}>
          {(id) => (
            <textarea id={id} rows={2} value={draft.description} onChange={(e) => set('description', e.target.value)} />
          )}
        </Field>
        <div className="gh-form-grid">
          <Field label={t('admin.connectors.url')} required>
            {input('url', { placeholder: 'https://example.com/mcp' })}
          </Field>
          <Field label={t('admin.connectors.transport')}>
            {(id) => (
              <select
                id={id}
                value={draft.transport}
                onChange={(e) => set('transport', e.target.value as Draft['transport'])}
              >
                <option value="streamable_http">Streamable HTTP</option>
                <option value="sse">{t('admin.connectors.sse')}</option>
              </select>
            )}
          </Field>
        </div>
        <div className="gh-button-row">
          <button
            type="button"
            className="gh-secondary-button"
            disabled={busy || !draft.url.trim()}
            onClick={() => void probe()}
          >
            {t('admin.connectors.probe')}
          </button>
          {probeNote ? (
            <span className="gh-hint" style={{ margin: 0, alignSelf: 'center' }}>
              {probeNote}
            </span>
          ) : null}
        </div>
        <h4 className="gh-form-heading">{t('admin.connectors.signIn')}</h4>
        {help ? <p className="gh-hint">{help}</p> : null}
        <div className="gh-form-grid">
          <Field label={t('admin.connectors.authModeLabel')}>
            {(id) => (
              <select
                id={id}
                value={draft.auth_mode}
                onChange={(e) => set('auth_mode', e.target.value as Draft['auth_mode'])}
              >
                {(['none', 'shared', 'per_member'] as const).map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`admin.connectors.authMode.${mode}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {credential ? (
            <Field label={t('admin.connectors.authKindLabel')}>
              {(id) => (
                <select
                  id={id}
                  value={draft.auth_kind}
                  onChange={(e) => set('auth_kind', e.target.value as Draft['auth_kind'])}
                >
                  <option value="key">{t('admin.connectors.authKind.key')}</option>
                  <option value="oauth">{t('admin.connectors.authKind.oauth')}</option>
                </select>
              )}
            </Field>
          ) : null}
        </div>
        {keyAuth ? (
          <div className="gh-form-grid">
            <Field label={t('admin.connectors.keyPlace')}>
              {(id) => (
                <select
                  id={id}
                  value={draft.auth_place}
                  onChange={(e) => set('auth_place', e.target.value as Draft['auth_place'])}
                >
                  <option value="header">{t('admin.connectors.header')}</option>
                  <option value="query">{t('admin.connectors.queryParam')}</option>
                </select>
              )}
            </Field>
            {draft.auth_place === 'header' ? (
              <Field label={t('admin.connectors.header')}>{input('auth_header')}</Field>
            ) : (
              <Field label={t('admin.connectors.queryParam')}>{input('auth_query_param')}</Field>
            )}
            <Field label={t('admin.connectors.prefix')} help={t('admin.connectors.prefixHint')}>
              {input('auth_value_prefix')}
            </Field>
            {draft.auth_mode === 'shared' ? (
              <Field
                label={t('admin.connectors.teamKey')}
                help={existing?.has_shared_secret ? t('admin.connectors.secretStored') : undefined}
              >
                {input('shared_secret', { type: 'password', autoComplete: 'off' })}
              </Field>
            ) : null}
          </div>
        ) : null}
        {oauthAuth ? (
          <div className="gh-form-grid">
            <Field label={t('admin.connectors.oauthScope')}>{input('oauth_scope')}</Field>
            <Field label={t('admin.connectors.clientId')} help={t('admin.connectors.clientIdHint')}>
              {input('oauth_client_id')}
            </Field>
            <Field
              label={t('admin.connectors.clientSecret')}
              help={existing?.oauth_client?.has_secret ? t('admin.connectors.secretStored') : undefined}
            >
              {input('oauth_client_secret', { type: 'password', autoComplete: 'off' })}
            </Field>
          </div>
        ) : null}
        <h4 className="gh-form-heading">{t('admin.connectors.access')}</h4>
        {existing ? (
          <label className="gh-check">
            <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            <span>{t('admin.connectors.enabled')}</span>
          </label>
        ) : null}
        <label className="gh-check">
          <input
            type="checkbox"
            checked={draft.private_network}
            onChange={(e) => set('private_network', e.target.checked)}
          />
          <span className="gh-admin-wrap">
            {t('admin.connectors.privateNetwork')}
            <small>{t('admin.connectors.privateNetworkHint')}</small>
          </span>
        </label>
        <label className="gh-check">
          <input
            type="checkbox"
            checked={draft.allow_external_writes}
            onChange={(e) => set('allow_external_writes', e.target.checked)}
          />
          <span className="gh-admin-wrap">
            {t('admin.connectors.externalWritesLabel')}
            <small>{t('admin.connectors.externalWritesHint')}</small>
          </span>
        </label>
        {existing && dropsCredentials(existing, draft) ? (
          <Callout>{t('admin.connectors.dropsCredentials')}</Callout>
        ) : null}
      </form>
    </AdminDialog>
  );
}

function ToolsDialog({ connector, close, saved }: { connector: TeamConnector; close: () => void; saved: () => void }) {
  const t = useT();
  const [tools, setTools] = useState<ConnectorTool[]>(connector.tools);
  const { busy, run } = useWrite();
  const update = (name: string, change: Partial<ConnectorTool>) =>
    setTools((list) => list.map((tool) => (tool.name === name ? { ...tool, ...change } : tool)));
  const save = async () => {
    if (await run(() => patch(`${BASE}/${seg(connector.id)}`, toolPolicy(tools)), t('admin.saveFailed'))) {
      toast(t('admin.saved'));
      saved();
      close();
    }
  };
  return (
    <AdminDialog
      size="lg"
      title={t('admin.connectors.toolsTitle', { name: connector.name })}
      onClose={close}
      testID="admin-connector-tools"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="button" className="gh-primary" disabled={busy || !tools.length} onClick={() => void save()}>
            {t('common.save')}
          </button>
        </>
      }
    >
      <div className="gh-form">
        <p className="gh-hint">{t('admin.connectors.toolsHint')}</p>
        {tools.length ? (
          tools.map((tool) => {
            const kind = toolKind(tool);
            return (
              <div key={tool.name} className="gh-admin-tool">
                <span className="gh-admin-wrap">
                  <span className="gh-mono">{tool.name}</span>{' '}
                  <Badge tone={KIND_TONE[kind]}>{t(`admin.connectors.kind.${kind}`)}</Badge>
                  {tool.description ? <small title={tool.description}>{tool.description}</small> : null}
                  {!tool.read_only ? (
                    <label style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
                      <input
                        type="checkbox"
                        checked={tool.vouched}
                        onChange={(e) =>
                          update(tool.name, {
                            vouched: e.target.checked,
                            ...(e.target.checked ? { enabled: true } : {}),
                          })
                        }
                      />
                      <small style={{ margin: 0 }}>{t('admin.connectors.vouch')}</small>
                    </label>
                  ) : null}
                </span>
                <Switch
                  checked={tool.enabled}
                  label={tool.name}
                  onChange={(next) => update(tool.name, { enabled: next })}
                />
              </div>
            );
          })
        ) : (
          <p className="gh-admin-empty-line">{t('admin.connectors.noTools')}</p>
        )}
      </div>
    </AdminDialog>
  );
}
