/**
 * McpKeysPanel — Administration › MCP Access (super-only).
 *
 * Mint and manage API keys for the MCP server (`/api/mcp`). Each key is bound to
 * an internal user (channel `a2a`) and inherits that user's permissions, narrowed
 * by the proxy allowlists. The raw key is shown ONCE on create/rotate.
 *
 * NOTE: distinct from the Desktop "MCP" section, which configures MCP *client*
 * sources the local agent consumes. This panel issues keys for external agents to
 * reach our resources.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Key, Plus, Trash2, RefreshCw, Check, AlertTriangle, ChevronDown, ChevronRight, Globe } from '../../lib/icons';
import {
  Button,
  Input,
  Select,
  Badge,
  Dialog,
  ConfirmDialog,
  EmptyState,
  ListToolbar,
  toast,
} from '../../components/ui';
import { authFetch } from '../../lib/auth';

interface ApiClient {
  id: string;
  app_id: string;
  app_name: string;
  status: 'active' | 'disabled';
  channel?: string;
  user_id?: string | null;
  rate_limit_rpm: number;
  rate_limit_rpd: number;
  created_at: string;
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

const MCP_CHANNEL = 'a2a';

function userLabel(u: InternalUser): string {
  return `${u.email || u.nickname || u.id} · ${u.role}`;
}

export function McpKeysPanel() {
  const [clients, setClients] = useState<ApiClient[]>([]);
  const [users, setUsers] = useState<InternalUser[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // One-time raw key reveal (after create / rotate).
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // "How to connect" collapsible.
  const [showConnect, setShowConnect] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  // Create dialog state.
  const [creating, setCreating] = useState(false);
  const [draftAppId, setDraftAppId] = useState('');
  const [draftAppName, setDraftAppName] = useState('');
  const [draftUserId, setDraftUserId] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ApiClient | null>(null);

  // Per-key activity (recent audit rows).
  const [activityFor, setActivityFor] = useState<ApiClient | null>(null);
  const [activityRows, setActivityRows] = useState<AuditRow[] | null>(null);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityLoading, setActivityLoading] = useState(false);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [cRes, uRes] = await Promise.all([authFetch('/api/admin/clients'), authFetch('/api/admin/users')]);
      if (cRes.ok) {
        const data = await cRes.json();
        setClients((data.clients as ApiClient[]).filter((c) => c.channel === MCP_CHANNEL));
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

  // Copy-paste client config. URL is same-origin (works in prod; dev proxies /api).
  const endpoint = `${window.location.origin}/api/mcp`;
  const configJson = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            greenhouse: {
              type: 'http',
              url: endpoint,
              headers: { Authorization: `Bearer ${revealedKey ?? 'gh_sk_YOUR_KEY'}` },
            },
          },
        },
        null,
        2,
      ),
    [endpoint, revealedKey],
  );
  const copyConfig = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(configJson);
      setCopiedConfig(true);
      setTimeout(() => setCopiedConfig(false), 1500);
    } catch {
      /* selectable fallback */
    }
  }, [configJson]);
  // Auto-expand the connect section once a fresh key is revealed (so the config carries it).
  useEffect(() => {
    if (revealedKey) setShowConnect(true);
  }, [revealedKey]);

  const openCreate = useCallback(() => {
    setDraftAppId('');
    setDraftAppName('');
    setDraftUserId(users[0]?.id ?? '');
    setCreating(true);
  }, [users]);

  const submitCreate = useCallback(async () => {
    if (!draftAppId.trim() || !draftAppName.trim() || !draftUserId) {
      toast('app id, name and a bound user are required', 'error');
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch('/api/admin/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          app_id: draftAppId.trim(),
          app_name: draftAppName.trim(),
          user_id: draftUserId,
          channel: MCP_CHANNEL,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast(data?.error || 'Failed to create key', 'error');
        return;
      }
      setRevealedKey(data.api_key);
      setCopied(false);
      setCreating(false);
      toast('MCP key created', 'success');
      await reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  }, [draftAppId, draftAppName, draftUserId, reload]);

  const rotate = useCallback(
    async (c: ApiClient) => {
      try {
        const res = await authFetch(`/api/admin/clients/${c.id}/rotate-key`, { method: 'POST' });
        const data = await res.json();
        if (!res.ok) {
          toast(data?.error || 'Failed to rotate key', 'error');
          return;
        }
        setRevealedKey(data.api_key);
        setCopied(false);
        toast(`Rotated key for ${c.app_name}`, 'success');
        await reload();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [reload],
  );

  const toggleStatus = useCallback(
    async (c: ApiClient) => {
      try {
        const res = await authFetch(`/api/admin/clients/${c.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: c.status === 'active' ? 'disabled' : 'active' }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data?.error || 'Failed to update status', 'error');
          return;
        }
        await reload();
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    [reload],
  );

  const copyKey = useCallback(async () => {
    if (!revealedKey) return;
    try {
      await navigator.clipboard.writeText(revealedKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard may be unavailable; the key is still selectable */
    }
  }, [revealedKey]);

  const openActivity = useCallback(async (c: ApiClient) => {
    setActivityFor(c);
    setActivityRows(null);
    setActivityLoading(true);
    try {
      const res = await authFetch(`/api/admin/clients/${c.id}/audit?limit=50`);
      const data = await res.json();
      if (res.ok) {
        setActivityRows((data.records ?? []) as AuditRow[]);
        setActivityTotal(data.total ?? 0);
      } else {
        setActivityRows([]);
        toast(data?.error || 'Failed to load activity', 'error');
      }
    } catch (err) {
      setActivityRows([]);
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setActivityLoading(false);
    }
  }, []);

  const createButton = (
    <Button size="sm" onClick={openCreate} disabled={users.length === 0}>
      <Plus size={14} className="mr-1" />
      Create key
    </Button>
  );

  return (
    <div>
      {/* Toolbar */}
      <ListToolbar
        className="mb-3"
        hint={
          <span className="block max-w-2xl">
            API keys for external agents to reach internal resources over MCP (
            <span className="font-mono">/api/mcp</span>). Each key is bound to an internal user and inherits that user's
            permissions (narrowed by the proxy allowlists). Bind a least-privilege user — never a personal or super
            account.
          </span>
        }
        count={`${clients.length} ${clients.length === 1 ? 'key' : 'keys'}`}
        actions={
          <>
            <Button size="sm" variant="ghost" onClick={() => void reload()} disabled={loading}>
              <RefreshCw size={14} className="mr-1" />
              Refresh
            </Button>
            {createButton}
          </>
        }
      />

      {/* Collapsible — how to connect an MCP client */}
      <div className="mb-3 rounded-lg border border-edge bg-surface-raised">
        <button
          onClick={() => setShowConnect((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-fg hover:bg-surface-sunken rounded-lg"
        >
          <span className="flex items-center gap-1.5">
            <Globe size={12} className="text-fg-muted" />
            How to connect an MCP client
          </span>
          {showConnect ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </button>
        {showConnect && (
          <div className="px-3 pb-3 pt-2 space-y-2 border-t border-edge">
            <p className="text-xs text-fg-muted">
              Streamable-HTTP MCP server. Paste this into your client config (Claude Desktop / Cursor /{' '}
              <span className="font-mono">.mcp.json</span>), replacing the key with one from “New key”:
            </p>
            <div className="relative">
              <pre className="text-[11px] leading-relaxed font-mono bg-surface-sunken text-fg-secondary rounded p-2 pr-16 overflow-x-auto">
                {configJson}
              </pre>
              <Button
                size="sm"
                variant="secondary"
                className="absolute top-1.5 right-1.5"
                onClick={() => void copyConfig()}
              >
                {copiedConfig ? <Check size={12} /> : null}
                {copiedConfig ? 'Copied' : 'Copy'}
              </Button>
            </div>
            <p className="text-[11px] text-fg-faint break-all">
              Endpoint <span className="font-mono">{endpoint}</span> · auth{' '}
              <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>. Stdio-only clients bridge via{' '}
              <span className="font-mono">npx mcp-remote {endpoint} --header "Authorization: Bearer &lt;key&gt;"</span>.
            </p>
          </div>
        )}
      </div>

      {error && <p className="text-xs text-danger mb-2">{error}</p>}

      {/* One-time key reveal */}
      {revealedKey && (
        <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 p-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-warning mb-1">
            <AlertTriangle size={12} />
            Save this key now — it is shown only once.
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono text-fg break-all bg-surface-sunken rounded px-2 py-1.5 select-all">
              {revealedKey}
            </code>
            <Button size="sm" variant="secondary" onClick={() => void copyKey()}>
              {copied ? <Check size={12} /> : null}
              {copied ? 'Copied' : 'Copy'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setRevealedKey(null)}>
              Dismiss
            </Button>
          </div>
        </div>
      )}

      {!loading && clients.length === 0 ? (
        <EmptyState
          icon={Key}
          title="No MCP keys yet"
          description="Create a key to let an external agent connect over MCP."
          action={createButton}
        />
      ) : (
        <div className="bg-surface-raised border border-edge rounded-lg overflow-x-auto">
          <table className="min-w-[760px] w-full text-xs">
            <thead className="bg-surface-sunken text-fg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-medium">App</th>
                <th className="px-3 py-2 text-left font-medium">Bound user</th>
                <th className="px-3 py-2 text-left font-medium">Status</th>
                <th className="px-3 py-2 text-left font-medium">Limits (rpm/rpd)</th>
                <th className="px-3 py-2 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {clients.map((c) => {
                const u = c.user_id ? userMap.get(c.user_id) : undefined;
                return (
                  <tr key={c.id} className="hover:bg-surface-sunken">
                    <td className="px-3 py-2 text-fg">
                      <div className="font-medium">{c.app_name}</div>
                      <div className="font-mono text-fg-faint">{c.app_id}</div>
                    </td>
                    <td className="px-3 py-2 text-fg-secondary" title={c.user_id ?? ''}>
                      {u ? userLabel(u) : (c.user_id ?? '—')}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={c.status === 'active' ? 'success' : 'destructive'}>{c.status}</Badge>
                    </td>
                    <td className="px-3 py-2 text-fg-faint">
                      {c.rate_limit_rpm}/{c.rate_limit_rpd}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" onClick={() => void openActivity(c)} title="Recent activity">
                        Activity
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void toggleStatus(c)}>
                        {c.status === 'active' ? 'Disable' : 'Enable'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void rotate(c)} title="Rotate key">
                        <RefreshCw size={12} />
                        Rotate
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleteTarget(c)} title="Delete">
                        <Trash2 size={12} />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={creating} onClose={() => setCreating(false)} title="New MCP key" size="md">
        <div className="space-y-3 px-1 pb-1">
          <Field label="App ID (lowercase slug, unique)">
            <Input
              size="sm"
              value={draftAppId}
              onChange={(e) => setDraftAppId(e.target.value)}
              placeholder="partner-agent"
            />
          </Field>
          <Field label="App name">
            <Input
              size="sm"
              value={draftAppName}
              onChange={(e) => setDraftAppName(e.target.value)}
              placeholder="Partner Agent"
            />
          </Field>
          <Field label="Bound internal user">
            <Select size="sm" value={draftUserId} onChange={(e) => setDraftUserId(e.target.value)}>
              {users.length === 0 && <option value="">No internal users</option>}
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {userLabel(u)}
                </option>
              ))}
            </Select>
          </Field>
          <p className="text-[11px] text-fg-faint">
            The key inherits this user's tool permissions, narrowed to the MCP-exposed set (knowledge / project / email
            / chat). Writes still require <span className="font-mono">confirm:true</span> per call.
          </p>
          <div className="flex justify-end gap-2 pt-2 border-t border-edge">
            <Button size="sm" variant="secondary" onClick={() => setCreating(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void submitCreate()} disabled={saving}>
              {saving ? 'Creating…' : 'Create key'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Activity dialog */}
      <Dialog
        open={activityFor !== null}
        onClose={() => setActivityFor(null)}
        title={`Activity — ${activityFor?.app_name ?? ''}`}
        size="lg"
      >
        <div className="space-y-2 px-1 pb-1">
          <p className="text-xs text-fg-faint">
            {activityTotal} total requests · showing latest {activityRows?.length ?? 0}
          </p>
          {activityLoading ? (
            <p className="text-xs text-fg-faint">Loading…</p>
          ) : !activityRows || activityRows.length === 0 ? (
            <p className="text-xs text-fg-faint">No requests recorded yet.</p>
          ) : (
            <div className="bg-surface-raised border border-edge rounded-lg overflow-hidden">
              <div className="overflow-x-auto max-h-[360px] overflow-y-auto">
                <table className="min-w-[560px] w-full text-xs">
                  <thead className="bg-surface-sunken text-fg-muted sticky top-0">
                    <tr>
                      <th className="px-2 py-1.5 text-left font-medium">Time</th>
                      <th className="px-2 py-1.5 text-left font-medium">Tool</th>
                      <th className="px-2 py-1.5 text-left font-medium">Status</th>
                      <th className="px-2 py-1.5 text-right font-medium">ms</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-edge">
                    {activityRows.map((r, i) => (
                      <tr key={i} className="hover:bg-surface-sunken">
                        <td className="px-2 py-1.5 text-fg-faint whitespace-nowrap">
                          {new Date(r.created_at).toLocaleString()}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-fg-secondary">{r.meta?.tool ?? r.endpoint}</td>
                        <td className="px-2 py-1.5">
                          <span className={r.status_code && r.status_code >= 400 ? 'text-danger' : 'text-success'}>
                            {r.status_code ?? '—'}
                          </span>
                          {r.error && (
                            <span className="text-danger ml-1" title={r.error}>
                              · err
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-1.5 text-right text-fg-faint">{r.duration_ms ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Delete MCP key"
        description={`Delete "${deleteTarget?.app_name}"? The key stops working immediately. This cannot be undone.`}
        confirmLabel="Delete"
        confirmVariant="destructive"
        onConfirm={async () => {
          if (!deleteTarget) return;
          try {
            const res = await authFetch(`/api/admin/clients/${deleteTarget.id}`, { method: 'DELETE' });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              toast(data?.error || 'Failed to delete', 'error');
              return;
            }
            toast(`Deleted ${deleteTarget.app_id}`, 'success');
            await reload();
          } finally {
            setDeleteTarget(null);
          }
        }}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-fg-secondary mb-1">{label}</label>
      {children}
    </div>
  );
}
