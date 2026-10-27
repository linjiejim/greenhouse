/**
 * MCP access (/api/admin/platform/oauth/*): machine clients (client_credentials) bound to a
 * least-privilege member — create, rotate the secret (shown once), disable, delete, recent calls —
 * and the interactive clients people registered by signing in from an MCP client (disable,
 * delete, calls). The data groups offered are the core ones plus the active plugins' groups.
 */
import React, { useCallback, useMemo, useState } from 'react';
import { del, get, patch, post, seg } from '../api/client';
import { useResource } from '../data/use-resource';
import { getApiBase } from '../store/stations';
import { useStationManifest } from '../plugins/store';
import { localize } from '../shared/plugins';
import { usePrefs } from '../store/prefs';
import { useT, localeOf } from '../lib/i18n';
import { Icon } from '../ui/core';
import { confirmAction } from '../ui/dialogs';
import { toast } from '../ui/toast';
import * as admin from './api';
import { AdminDialog, AdminPage, Badge, Callout, Card, Field, SectionState } from './kit.web';
import { useWrite } from './use-write';
import { dateTimeLabel, dayLabel } from './format';

interface OAuthClient {
  id: string;
  client_name: string;
  allowed_scopes: string[];
  bound_user_id: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  machine: boolean;
  granted_user_ids?: string[];
}
interface AuditRow {
  created_at: string;
  endpoint: string;
  status_code?: number | null;
  duration_ms?: number | null;
  meta?: { tool?: string } | null;
  error?: string | null;
}

const BASE = '/api/admin/platform/oauth';
/** Core MCP data groups offered to new clients (`image` is retired; grants holding it still work). */
const CORE_GROUPS = ['files', 'chat', 'automation', 'services', 'connectors'] as const;

export default function McpKeysSection() {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const manifest = useStationManifest((s) => s.data);
  const clients = useResource(useCallback(() => get<{ clients: OAuthClient[] }>(`${BASE}/clients`), []));
  const users = useResource(useCallback(() => admin.listUsers(), []));
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<{ clientId: string; secret: string } | null>(null);
  const [activity, setActivity] = useState<OAuthClient | null>(null);
  const [connect, setConnect] = useState(false);
  const { busy, run } = useWrite();
  const members = useMemo(
    () => (users.data?.users ?? []).filter((u) => u.role === 'super' || u.role === 'team'),
    [users.data],
  );
  const nameOf = (id: string) => {
    const u = members.find((m) => m.id === id);
    return u ? u.nickname || u.email : id;
  };
  const groups = useMemo(
    () => [
      ...CORE_GROUPS.map((id) => ({
        id,
        label: t(`admin.mcp.group.${id}.label`),
        description: t(`admin.mcp.group.${id}.description`),
      })),
      ...(manifest.kind === 'v2'
        ? manifest.manifest.plugins.flatMap((p) =>
            p.mcp_groups.map((id) => ({
              id,
              label: localize(p.name, lang),
              description: t('admin.mcp.pluginGroup', { name: localize(p.name, lang) }),
            })),
          )
        : []),
    ],
    [manifest, lang, t],
  );
  const endpoint = `${getApiBase()}/api/mcp`;
  const tokenExample = [
    `curl -s -X POST ${getApiBase()}/oauth/token \\`,
    '  -d grant_type=client_credentials \\',
    `  -d client_id=${revealed?.clientId ?? 'lpoa_client_YOUR_ID'} \\`,
    `  -d client_secret=${revealed?.secret ?? 'lpoa_cs_YOUR_SECRET'}`,
  ].join('\n');
  const reload = () => void clients.refresh();
  const rotate = async (c: OAuthClient) => {
    const ok = await confirmAction({
      title: t('admin.mcp.rotateTitle', { name: c.client_name }),
      message: t('admin.mcp.rotateHint'),
      confirmLabel: t('admin.mcp.rotate'),
    });
    if (!ok) return;
    const answer = await run(
      () => post<{ client_secret: string }>(`${BASE}/machine-clients/${seg(c.id)}/rotate-secret`),
      t('admin.mcp.rotateFailed'),
    );
    if (!answer) return;
    setRevealed({ clientId: c.id, secret: answer.client_secret });
    setConnect(true);
    toast(t('admin.mcp.rotated', { name: c.client_name }));
    reload();
  };
  const toggle = async (c: OAuthClient) => {
    if (c.status === 'active') {
      const ok = await confirmAction({
        title: t('admin.mcp.disableTitle', { name: c.client_name }),
        message: t('admin.mcp.disableHint'),
        confirmLabel: t('admin.mcp.disable'),
        destructive: true,
      });
      if (!ok) return;
    }
    const answer = await run(
      () => patch(`${BASE}/clients/${seg(c.id)}`, { status: c.status === 'active' ? 'disabled' : 'active' }),
      t('admin.mcp.statusFailed'),
    );
    if (answer) reload();
  };
  const remove = async (c: OAuthClient) => {
    const ok = await confirmAction({
      title: t('admin.mcp.deleteTitle', { name: c.client_name }),
      message: t('admin.mcp.deleteHint'),
      confirmLabel: t('admin.mcp.delete'),
      destructive: true,
    });
    if (!ok) return;
    if (await run(() => del(`${BASE}/clients/${seg(c.id)}`), t('admin.mcp.deleteFailed'))) {
      toast(t('admin.mcp.deleted', { name: c.client_name }));
      reload();
    }
  };
  const all = clients.data?.clients;
  const machine = all?.filter((c) => c.machine) ?? [];
  const interactive = all?.filter((c) => !c.machine) ?? [];
  const status = (c: OAuthClient) => (
    <Badge tone={c.status === 'active' ? 'success' : 'neutral'}>
      {c.status === 'active' ? t('admin.mcp.active') : t('admin.mcp.disabled')}
    </Badge>
  );
  const actions = (c: OAuthClient) => (
    <>
      <button className="gh-link-button" onClick={() => setActivity(c)}>
        {t('admin.mcp.calls')}
      </button>
      {c.machine ? (
        <button className="gh-link-button" disabled={busy} onClick={() => void rotate(c)}>
          {t('admin.mcp.rotate')}
        </button>
      ) : null}
      <button className="gh-link-button" disabled={busy} onClick={() => void toggle(c)}>
        {c.status === 'active' ? t('admin.mcp.disable') : t('admin.mcp.enable')}
      </button>
      <button
        className="gh-icon-button"
        aria-label={t('admin.mcp.deleteNamed', { name: c.client_name })}
        disabled={busy}
        onClick={() => void remove(c)}
      >
        <Icon name="trash" size={15} />
      </button>
    </>
  );
  return (
    <AdminPage
      title={t('admin.sections.mcp-keys')}
      testID="admin-mcp"
      actions={
        <>
          <button
            className="gh-icon-button"
            aria-label={t('common.refresh')}
            disabled={clients.loading}
            onClick={reload}
          >
            <Icon name="refresh" size={16} />
          </button>
          <button className="gh-primary" disabled={!members.length} onClick={() => setCreating(true)}>
            {t('admin.mcp.newMachine')}
          </button>
        </>
      }
    >
      {revealed ? (
        <Callout
          icon="key"
          testID="admin-mcp-secret"
          action={
            <button className="gh-secondary-button" onClick={() => setRevealed(null)}>
              {t('admin.mcp.dismiss')}
            </button>
          }
        >
          <strong>{t('admin.mcp.secretOnce')}</strong>
          <div className="gh-mono">client_id {revealed.clientId}</div>
          <div className="gh-admin-secret" style={{ marginTop: 8 }}>
            <code>{revealed.secret}</code>
            <button
              className="gh-secondary-button"
              onClick={() => {
                void navigator.clipboard?.writeText(revealed.secret).then(() => toast(t('common.copied')));
              }}
            >
              <Icon name="copy" size={14} />
              {t('admin.copy')}
            </button>
          </div>
        </Callout>
      ) : null}
      <Card
        title={t('admin.mcp.howToConnect')}
        icon="globe"
        actions={
          <button className="gh-link-button" aria-expanded={connect} onClick={() => setConnect((v) => !v)}>
            {connect ? t('admin.permissions.hide') : t('admin.mcp.show')}
          </button>
        }
      >
        {connect ? (
          <>
            <p className="gh-hint">{t('admin.mcp.interactiveHelp', { endpoint })}</p>
            <p className="gh-hint">{t('admin.mcp.machineHelp', { endpoint })}</p>
            <pre className="gh-admin-code">{tokenExample}</pre>
          </>
        ) : (
          <p className="gh-hint gh-mono" style={{ margin: 0 }}>
            {endpoint}
          </p>
        )}
      </Card>
      {!all ? (
        <SectionState loading={clients.loading} error={clients.error} retry={reload} />
      ) : (
        <>
          <Card title={t('admin.mcp.machineClients')} icon="server" flush testID="admin-mcp-machine">
            {machine.length ? (
              <table className="gh-data-grid gh-admin-grid">
                <thead>
                  <tr>
                    <th>{t('admin.mcp.client')}</th>
                    <th>{t('admin.mcp.boundUser')}</th>
                    <th>{t('admin.mcp.scopes')}</th>
                    <th>{t('admin.metering.status')}</th>
                    <th>{t('admin.mcp.createdAt')}</th>
                    <th aria-label={t('admin.actions')} />
                  </tr>
                </thead>
                <tbody>
                  {machine.map((c) => (
                    <tr key={c.id} data-muted={c.status === 'active' ? undefined : ''}>
                      <td title={c.id}>
                        <strong>{c.client_name}</strong>
                        <span className="gh-admin-sub gh-mono">{c.id}</span>
                      </td>
                      <td>{c.bound_user_id ? nameOf(c.bound_user_id) : '—'}</td>
                      <td className="gh-admin-wrap">
                        <span className="gh-chip-row">
                          {c.allowed_scopes.map((s) => (
                            <Badge key={s} tone={s === 'mcp:write' ? 'warning' : 'neutral'}>
                              {s}
                            </Badge>
                          ))}
                        </span>
                      </td>
                      <td>{status(c)}</td>
                      <td>{dayLabel(c.created_at, localeOf(lang))}</td>
                      <td className="gh-admin-actions">{actions(c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="gh-admin-empty-line">{t('admin.mcp.noMachine')}</p>
            )}
          </Card>
          <Card
            title={t('admin.mcp.interactiveClients')}
            icon="users"
            hint={t('admin.mcp.interactiveHint')}
            flush
            testID="admin-mcp-interactive"
          >
            {interactive.length ? (
              <table className="gh-data-grid gh-admin-grid">
                <thead>
                  <tr>
                    <th>{t('admin.mcp.client')}</th>
                    <th>{t('admin.mcp.authorized')}</th>
                    <th>{t('admin.metering.status')}</th>
                    <th>{t('admin.mcp.createdAt')}</th>
                    <th aria-label={t('admin.actions')} />
                  </tr>
                </thead>
                <tbody>
                  {interactive.map((c) => (
                    <tr key={c.id} data-muted={c.status === 'active' ? undefined : ''}>
                      <td title={c.id}>
                        <strong>{c.client_name}</strong>
                      </td>
                      <td className="gh-admin-wrap">
                        {c.granted_user_ids?.length ? c.granted_user_ids.map(nameOf).join(t('common.listSep')) : '—'}
                      </td>
                      <td>{status(c)}</td>
                      <td>{dayLabel(c.created_at, localeOf(lang))}</td>
                      <td className="gh-admin-actions">{actions(c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="gh-admin-empty-line">{t('admin.mcp.noInteractive')}</p>
            )}
          </Card>
        </>
      )}
      {creating ? (
        <CreateMachineClient
          members={members.map((m) => ({ id: m.id, label: `${m.nickname || m.email} · ${m.role}` }))}
          groups={groups}
          close={() => setCreating(false)}
          created={(clientId, secret) => {
            setRevealed({ clientId, secret });
            setConnect(true);
            reload();
          }}
        />
      ) : null}
      {activity ? <ClientCalls client={activity} close={() => setActivity(null)} /> : null}
    </AdminPage>
  );
}

function CreateMachineClient({
  members,
  groups,
  close,
  created,
}: {
  members: { id: string; label: string }[];
  groups: { id: string; label: string; description: string }[];
  close: () => void;
  created: (clientId: string, secret: string) => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [user, setUser] = useState(members[0]?.id ?? '');
  const [write, setWrite] = useState(false);
  // narrowing is the deliberate act: a client with no group ticked can call nothing
  const [picked, setPicked] = useState(() => new Set(groups.map((g) => g.id)));
  const { busy, run } = useWrite();
  const ready = !!name.trim() && !!user && picked.size > 0;
  const submit = async () => {
    if (!ready) return;
    const answer = await run(
      () =>
        post<{ client_id: string; client_secret: string }>(`${BASE}/machine-clients`, {
          client_name: name.trim(),
          bound_user_id: user,
          scopes: [
            'mcp:read',
            ...(write ? ['mcp:write'] : []),
            ...groups.filter((g) => picked.has(g.id)).map((g) => `mcp:${g.id}`),
          ],
        }),
      t('admin.mcp.createFailed'),
    );
    if (!answer) return;
    toast(t('admin.mcp.created'));
    created(answer.client_id, answer.client_secret);
    close();
  };
  return (
    <AdminDialog
      title={t('admin.mcp.newMachine')}
      onClose={close}
      testID="admin-mcp-create"
      footer={
        <>
          <button type="button" className="gh-secondary-button" onClick={close}>
            {t('common.cancel')}
          </button>
          <button type="submit" form="admin-mcp-create" className="gh-primary" disabled={busy || !ready}>
            {t('admin.mcp.create')}
          </button>
        </>
      }
    >
      <form
        id="admin-mcp-create"
        className="gh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field label={t('admin.mcp.clientName')} required>
          {(id) => <input id={id} value={name} placeholder="skillhub-sync" onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label={t('admin.mcp.boundUserHint')} required>
          {(id) => (
            <select id={id} value={user} onChange={(e) => setUser(e.target.value)}>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          )}
        </Field>
        <label className="gh-check">
          <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
          <span className="gh-admin-wrap">{t('admin.mcp.allowWrites')}</span>
        </label>
        <h4 className="gh-form-heading">{t('admin.mcp.capabilities')}</h4>
        <p className="gh-hint">{t('admin.mcp.capabilitiesHint')}</p>
        {groups.map((g) => (
          <label key={g.id} className="gh-check">
            <input
              type="checkbox"
              checked={picked.has(g.id)}
              onChange={(e) =>
                setPicked((current) => {
                  const next = new Set(current);
                  if (e.target.checked) next.add(g.id);
                  else next.delete(g.id);
                  return next;
                })
              }
            />
            <span>
              {g.label}
              <small>{g.description}</small>
            </span>
          </label>
        ))}
      </form>
    </AdminDialog>
  );
}

function ClientCalls({ client, close }: { client: OAuthClient; close: () => void }) {
  const t = useT();
  const lang = usePrefs((s) => s.lang);
  const data = useResource(
    useCallback(
      () => get<{ records: AuditRow[]; total: number }>(`${BASE}/clients/${seg(client.id)}/audit`, { limit: 50 }),
      [client.id],
    ),
  );
  const rows = data.data?.records;
  return (
    <AdminDialog
      size="lg"
      title={t('admin.mcp.callsTitle', { name: client.client_name })}
      onClose={close}
      testID="admin-mcp-calls"
    >
      {!rows ? (
        <SectionState loading={data.loading} error={data.error} retry={() => void data.refresh()} />
      ) : rows.length ? (
        <div className="gh-form">
          <p className="gh-hint">{t('admin.mcp.callsTotal', { n: data.data?.total ?? rows.length })}</p>
          <table className="gh-data-grid gh-admin-grid">
            <thead>
              <tr>
                <th>{t('admin.mcp.time')}</th>
                <th>{t('admin.mcp.endpoint')}</th>
                <th>{t('admin.mcp.tool')}</th>
                <th className="gh-number">{t('admin.metering.status')}</th>
                <th className="gh-number">ms</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{dateTimeLabel(r.created_at, localeOf(lang))}</td>
                  <td className="gh-mono">{r.endpoint}</td>
                  <td className="gh-mono">{r.meta?.tool ?? '—'}</td>
                  <td className="gh-number">
                    {r.error || (r.status_code ?? 0) >= 400 ? (
                      <Badge tone="danger">{r.status_code ?? '—'}</Badge>
                    ) : (
                      (r.status_code ?? '—')
                    )}
                  </td>
                  <td className="gh-number">{r.duration_ms ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="gh-admin-empty-line">{t('admin.mcp.noCalls')}</p>
      )}
    </AdminDialog>
  );
}
