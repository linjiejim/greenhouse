/**
 * McpKeysPanel — Administration › MCP Access (super-only).
 *
 * OAuth-only MCP boundary management, backed by /api/admin/platform/oauth/*:
 * - Machine clients (client_credentials): create / rotate secret / disable /
 *   delete / per-client activity. Each is bound to a least-privilege internal
 *   user; the client_secret is shown ONCE on create/rotate.
 * - Interactive clients (public, DCR-registered): visibility + disable/delete.
 *   Interactive users authenticate via OAuth login in their MCP client and
 *   never need anything minted here.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { MCP_RESOURCE_GROUP_IDS } from '@greenhouse/types/mcp';
import { Plus, Trash2, RefreshCw, Check, AlertTriangle, ChevronDown, ChevronRight, Globe } from '../../lib/icons';
import { Badge, Button, Checkbox, ConfirmDialog, Dialog, Input, Select, toast } from '../../components/ui';
import { FormActions, FormField } from '../../components/form';
import { ModulePage } from '../../components/app/module-page';
import { authFetch } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { mcpGroupDescriptionKey, mcpGroupLabelKey } from '../../lib/mcp-groups';
import { formatDate } from '../../lib/utils';

interface OAuthClient {
  id: string;
  client_name: string;
  redirect_uris: string[];
  allowed_scopes: string[];
  token_endpoint_auth_method: 'none' | 'client_secret_post';
  bound_user_id: string | null;
  status: 'active' | 'disabled';
  created_at: string;
  machine: boolean;
  /** Users with an active OAuth grant on this client (interactive logins). */
  granted_user_ids?: string[];
}

interface InternalUser {
  id: string;
  email?: string | null;
  nickname?: string | null;
  role: string;
}

interface AuditRow {
  created_at: string;
  endpoint: string;
  status_code?: number | null;
  duration_ms?: number | null;
  meta?: { tool?: string } | null;
  error?: string | null;
}

const ADMIN_BASE = '/api/admin/platform/oauth';

function userLabel(u: InternalUser): string {
  return `${u.email || u.nickname || u.id} · ${u.role}`;
}

export function McpKeysPanel() {
  const t = useT();
  const [clients, setClients] = useState<OAuthClient[]>([]);
  const [users, setUsers] = useState<InternalUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // One-time credential reveal (after create / rotate).
  const [revealed, setRevealed] = useState<{ clientId: string; secret: string } | null>(null);
  const [copied, setCopied] = useState(false);

  // "How to connect" collapsible.
  const [showConnect, setShowConnect] = useState(false);

  // Create dialog state.
  const [creating, setCreating] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [draftUserId, setDraftUserId] = useState('');
  const [draftWrite, setDraftWrite] = useState(false);
  const [draftGroups, setDraftGroups] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<OAuthClient | null>(null);

  // Per-client activity (recent audit rows).
  const [activityFor, setActivityFor] = useState<OAuthClient | null>(null);
  const [activityRows, setActivityRows] = useState<AuditRow[] | null>(null);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityLoading, setActivityLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cRes, uRes] = await Promise.all([authFetch(`${ADMIN_BASE}/clients`), authFetch('/api/admin/users')]);
      if (cRes.ok) {
        const data = await cRes.json();
        setClients(data.clients as OAuthClient[]);
      }
      if (uRes.ok) {
        const data = await uRes.json();
        setUsers((data.users as InternalUser[]).filter((u) => u.role === 'super' || u.role === 'team'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  const machineClients = useMemo(() => clients.filter((c) => c.machine), [clients]);
  const publicClients = useMemo(() => clients.filter((c) => !c.machine), [clients]);

  const endpoint = `${window.location.origin}/api/mcp`;
  const tokenEndpoint = `${window.location.origin}/oauth/token`;
  const tokenExample = useMemo(
    () =>
      [
        `curl -s -X POST ${tokenEndpoint} \\`,
        `  -d grant_type=client_credentials \\`,
        `  -d client_id=${revealed?.clientId ?? 'lpoa_client_YOUR_ID'} \\`,
        `  -d client_secret=${revealed?.secret ?? 'lpoa_cs_YOUR_SECRET'}`,
      ].join('\n'),
    [tokenEndpoint, revealed],
  );

  // Auto-expand the connect section once fresh credentials are revealed.
  useEffect(() => {
    if (revealed) setShowConnect(true);
  }, [revealed]);

  const openCreate = useCallback(() => {
    setDraftName('');
    setDraftUserId(users[0]?.id ?? '');
    setDraftWrite(false);
    // Start from everything: narrowing is the deliberate act, and a machine
    // client with no capability ticked cannot call anything at all.
    setDraftGroups(new Set([...MCP_RESOURCE_GROUP_IDS]));
    setCreating(true);
  }, [users]);

  const toggleDraftGroup = useCallback((id: string, checked: boolean) => {
    setDraftGroups((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const submitCreate = useCallback(async () => {
    if (!draftName.trim() || !draftUserId) {
      toast(t('mcpAccess.requiredFields'), 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`${ADMIN_BASE}/machine-clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_name: draftName.trim(),
          bound_user_id: draftUserId,
          scopes: [
            'mcp:read',
            ...(draftWrite ? ['mcp:write'] : []),
            ...MCP_RESOURCE_GROUP_IDS.filter((id) => draftGroups.has(id)).map((id) => `mcp:${id}`),
          ],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data?.error || t('mcpAccess.createFailed'), 'error');
        return;
      }
      setRevealed({ clientId: data.client_id, secret: data.client_secret });
      setCopied(false);
      setCreating(false);
      toast(t('mcpAccess.created'), 'success');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  }, [draftName, draftUserId, draftWrite, draftGroups, reload, t]);

  const rotate = useCallback(
    async (c: OAuthClient) => {
      try {
        const res = await authFetch(`${ADMIN_BASE}/machine-clients/${c.id}/rotate-secret`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          toast(data?.error || t('mcpAccess.rotateFailed'), 'error');
          return;
        }
        setRevealed({ clientId: c.id, secret: data.client_secret });
        setCopied(false);
        toast(t('mcpAccess.rotated', { name: c.client_name }), 'success');
        await reload();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [reload, t],
  );

  const toggleStatus = useCallback(
    async (c: OAuthClient) => {
      try {
        const res = await authFetch(`${ADMIN_BASE}/clients/${c.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: c.status === 'active' ? 'disabled' : 'active' }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error || t('mcpAccess.statusFailed'), 'error');
          return;
        }
        await reload();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [reload, t],
  );

  const copySecret = useCallback(async () => {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; the secret is still selectable */
    }
  }, [revealed]);

  const openActivity = useCallback(
    async (c: OAuthClient) => {
      setActivityFor(c);
      setActivityRows(null);
      setActivityLoading(true);
      try {
        const res = await authFetch(`${ADMIN_BASE}/clients/${c.id}/audit?limit=50`);
        const data = await res.json();
        if (res.ok) {
          setActivityRows((data.records ?? []) as AuditRow[]);
          setActivityTotal(data.total ?? 0);
        } else {
          setActivityRows([]);
          toast(data?.error || t('mcpAccess.activityFailed'), 'error');
        }
      } catch (err) {
        setActivityRows([]);
        toast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setActivityLoading(false);
      }
    },
    [t],
  );

  const statusBadge = (c: OAuthClient) => (
    <Badge variant={c.status === 'active' ? 'success' : 'secondary'}>
      {c.status === 'active' ? t('common.active') : t('common.inactive')}
    </Badge>
  );

  return (
    <ModulePage
      moduleId="admin.mcp-keys"
      layout="list"
      actions={
        <>
          <Badge variant="secondary">{clients.length}</Badge>
          <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
            <RefreshCw size={12} />
            {t('common.refresh')}
          </Button>
          <Button size="sm" onClick={openCreate} disabled={users.length === 0}>
            <Plus size={12} />
            {t('mcpAccess.newMachineClient')}
          </Button>
        </>
      }
    >
      <div>
        {/* Collapsible — how to connect */}
        <div className="mb-3 rounded-lg border border-edge bg-surface-raised">
          <button
            onClick={() => setShowConnect((v) => !v)}
            className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-fg hover:bg-surface-sunken rounded-lg"
          >
            <span className="flex items-center gap-1.5">
              <Globe size={12} className="text-fg-muted" />
              {t('mcpAccess.howToConnect')}
            </span>
            {showConnect ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </button>
          {showConnect && (
            <div className="px-3 pb-3 pt-2 space-y-2 border-t border-edge">
              <p className="text-xs text-fg-muted">{t('mcpAccess.interactiveHelp', { endpoint })}</p>
              <p className="text-xs text-fg-muted">{t('mcpAccess.automationHelp', { endpoint })}</p>
              <pre className="text-[11px] leading-relaxed font-mono bg-surface-sunken text-fg-secondary rounded p-2 overflow-x-auto">
                {tokenExample}
              </pre>
            </div>
          )}
        </div>

        {error && <p className="text-xs text-danger mb-2">{error}</p>}

        {/* One-time credential reveal */}
        {revealed && (
          <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-warning mb-1">
              <AlertTriangle size={12} />
              {t('mcpAccess.secretOnce')}
            </div>
            <div className="space-y-1.5">
              <div className="text-[11px] text-fg-muted">
                client_id <code className="font-mono text-fg select-all">{revealed.clientId}</code>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono text-fg break-all bg-surface-sunken rounded px-2 py-1.5 select-all">
                  {revealed.secret}
                </code>
                <Button size="sm" variant="secondary" onClick={() => void copySecret()}>
                  {copied ? <Check size={12} /> : null}
                  {copied ? t('common.copied') : t('common.copy')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setRevealed(null)}>
                  {t('common.dismiss')}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Machine clients */}
        <div className="mb-1 text-xs font-semibold text-fg">{t('mcpAccess.machineClients')}</div>
        <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto mb-4">
          <table className="min-w-[760px] w-full text-xs">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('mcpAccess.client')}</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('mcpAccess.boundUser')}</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('mcpAccess.scopes')}</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('common.status')}</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('mcpAccess.createdAt')}</th>
                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {machineClients.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-3 py-6 text-center text-fg-faint">
                    {loading ? t('common.loading') : t('mcpAccess.noMachineClients')}
                  </td>
                </tr>
              )}
              {machineClients.map((c) => {
                const bound = c.bound_user_id ? userMap.get(c.bound_user_id) : undefined;
                return (
                  <tr key={c.id} className="border-t border-edge">
                    <td className="px-3 py-2">
                      <div className="font-medium text-fg">{c.client_name}</div>
                      <div className="font-mono text-[11px] text-fg-faint" title={c.id}>
                        {c.id}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-fg-secondary whitespace-nowrap">
                      {bound ? userLabel(bound) : (c.bound_user_id ?? '—')}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {c.allowed_scopes.map((s) => (
                          <Badge key={s} variant={s === 'mcp:write' ? 'warning' : 'secondary'}>
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-3 py-2">{statusBadge(c)}</td>
                    <td className="px-3 py-2 text-fg-faint whitespace-nowrap">{formatDate(c.created_at)}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => void openActivity(c)}>
                        {t('mcpAccess.activity')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void rotate(c)}>
                        {t('mcpAccess.rotateSecret')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void toggleStatus(c)}>
                        {c.status === 'active' ? t('common.disable') : t('common.enable')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(c)}>
                        <Trash2 size={12} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Interactive (public) clients — registered via DCR when users log in */}
        <div className="mb-1 text-xs font-semibold text-fg">{t('mcpAccess.interactiveClients')}</div>
        <p className="text-[11px] text-fg-muted mb-2">{t('mcpAccess.interactiveDescription')}</p>
        <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
          <table className="min-w-[640px] w-full text-xs">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('mcpAccess.client')}</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('mcpAccess.authorizedUsers')}</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('common.status')}</th>
                <th className="px-3 py-2 text-left font-medium whitespace-nowrap">{t('mcpAccess.createdAt')}</th>
                <th className="px-3 py-2 text-right font-medium whitespace-nowrap">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {publicClients.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-6 text-center text-fg-faint">
                    {loading ? t('common.loading') : t('mcpAccess.noInteractiveClients')}
                  </td>
                </tr>
              )}
              {publicClients.map((c) => (
                <tr key={c.id} className="border-t border-edge">
                  <td className="px-3 py-2">
                    <div className="font-medium text-fg">{c.client_name}</div>
                    <div className="font-mono text-[11px] text-fg-faint" title={c.id}>
                      {c.id}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-fg-secondary">
                    {c.granted_user_ids?.length
                      ? c.granted_user_ids
                          .map((id) => userMap.get(id)?.email || userMap.get(id)?.nickname || id)
                          .join(', ')
                      : '—'}
                  </td>
                  <td className="px-3 py-2">{statusBadge(c)}</td>
                  <td className="px-3 py-2 text-fg-faint whitespace-nowrap">{formatDate(c.created_at)}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => void openActivity(c)}>
                      {t('mcpAccess.activity')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void toggleStatus(c)}>
                      {c.status === 'active' ? t('common.disable') : t('common.enable')}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(c)}>
                      <Trash2 size={12} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Create machine client dialog */}
        <Dialog open={creating} onClose={() => setCreating(false)} title={t('mcpAccess.newMachineClient')}>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-fg mb-1">{t('mcpAccess.clientName')}</label>
              <Input value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="skillhub-sync" />
            </div>
            <div>
              <label className="block text-xs font-medium text-fg mb-1">{t('mcpAccess.boundUserLeastPrivilege')}</label>
              <Select value={draftUserId} onChange={(e) => setDraftUserId(e.target.value)}>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {userLabel(u)}
                  </option>
                ))}
              </Select>
            </div>
            <Checkbox
              checked={draftWrite}
              onChange={(e) => setDraftWrite(e.target.checked)}
              label={t('mcpAccess.allowWrites')}
            />
            <FormField label={t('mcpAccess.capabilities')} help={t('mcpAccess.capabilitiesHint')}>
              <div className="max-h-52 divide-y divide-edge overflow-y-auto rounded-lg border border-edge">
                {MCP_RESOURCE_GROUP_IDS.map((id) => (
                  <label key={id} className="flex cursor-pointer items-start gap-2 p-2 hover:bg-surface-muted">
                    <Checkbox
                      checked={draftGroups.has(id)}
                      onChange={(e) => toggleDraftGroup(id, e.target.checked)}
                      className="mt-0.5"
                    />
                    <span className="min-w-0">
                      <span className="block text-xs text-fg">{t(mcpGroupLabelKey(id))}</span>
                      <span className="block text-[11px] text-fg-muted">{t(mcpGroupDescriptionKey(id))}</span>
                    </span>
                  </label>
                ))}
              </div>
            </FormField>
            <FormActions>
              <Button size="sm" variant="ghost" onClick={() => setCreating(false)}>
                {t('common.cancel')}
              </Button>
              <Button size="sm" onClick={() => void submitCreate()} disabled={saving || draftGroups.size === 0}>
                {t('common.create')}
              </Button>
            </FormActions>
          </div>
        </Dialog>

        <ConfirmDialog
          open={!!deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={async () => {
            if (!deleteTarget) return;
            try {
              const res = await authFetch(`${ADMIN_BASE}/clients/${deleteTarget.id}`, { method: 'DELETE' });
              if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                toast(data?.error || t('mcpAccess.deleteFailed'), 'error');
                return;
              }
              toast(t('mcpAccess.deleted', { name: deleteTarget.client_name }), 'success');
              await reload();
            } catch (err) {
              toast(err instanceof Error ? err.message : String(err), 'error');
            } finally {
              setDeleteTarget(null);
            }
          }}
          title={t('mcpAccess.deleteTitle')}
          description={t('mcpAccess.deleteDescription', { name: deleteTarget?.client_name ?? '' })}
        />

        {/* Per-client activity */}
        <Dialog
          open={!!activityFor}
          onClose={() => setActivityFor(null)}
          title={t('mcpAccess.activityTitle', { name: activityFor?.client_name ?? '' })}
          size="workspace"
        >
          {activityLoading && <p className="text-xs text-fg-muted">{t('common.loading')}</p>}
          {!activityLoading && activityRows && activityRows.length === 0 && (
            <p className="text-xs text-fg-muted">{t('mcpAccess.noCalls')}</p>
          )}
          {!activityLoading && activityRows && activityRows.length > 0 && (
            <div className="max-h-[65vh] overflow-y-auto pr-2">
              <p className="text-[11px] text-fg-faint mb-1">{t('mcpAccess.callsTotal', { count: activityTotal })}</p>
              <table className="w-full text-[11px]">
                <thead className="text-fg-muted">
                  <tr>
                    <th className="py-1 text-left font-medium">{t('mcpAccess.time')}</th>
                    <th className="py-1 text-left font-medium">{t('mcpAccess.endpoint')}</th>
                    <th className="py-1 text-left font-medium">{t('mcpAccess.tool')}</th>
                    <th className="py-1 text-right font-medium">{t('common.status')}</th>
                    <th className="py-1 text-right font-medium">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {activityRows.map((r, i) => (
                    <tr key={i} className="border-t border-edge">
                      <td className="py-1 pr-2 whitespace-nowrap text-fg-faint">
                        {r.created_at?.replace('T', ' ').slice(0, 19)}
                      </td>
                      <td className="py-1 pr-2 font-mono">{r.endpoint}</td>
                      <td className="py-1 pr-2 font-mono">{r.meta?.tool ?? '—'}</td>
                      <td
                        className={`py-1 text-right ${r.error || (r.status_code ?? 0) >= 400 ? 'text-danger' : 'text-fg-secondary'}`}
                      >
                        {r.status_code ?? '—'}
                      </td>
                      <td className="py-1 text-right text-fg-faint">{r.duration_ms ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Dialog>
      </div>
    </ModulePage>
  );
}
