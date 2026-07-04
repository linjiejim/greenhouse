/**
 * McpKeysPanel — Administration › MCP Access (super-only).
 *
 * Rebuilt on @greenhouse/crud to exercise its escape hatches on a genuinely
 * bespoke page: CrudPage owns the list (typed columns) + row actions
 * (Activity / Enable-Disable / Rotate / Delete via tableActions) + toolbar
 * (Refresh / Create via pageActions), while the "how to connect" callout, the
 * one-time raw-key reveal, and the Create / Activity dialogs stay bespoke —
 * mounted through the `banner` slot + sibling overlays, refreshed via ctx.reload.
 *
 * NOTE: distinct from the Desktop "MCP" section (MCP *client* sources). This
 * panel issues keys for external agents to reach our resources over /api/mcp.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { defineCrud, CrudPage, type CrudDataSource, type CrudActionContext } from '@greenhouse/crud';
import {
  Key,
  Plus,
  Trash2,
  RefreshCw,
  Check,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Globe,
  History,
  Ban,
} from '../../lib/icons';
import { Button, Input, Select, Dialog, ConfirmDialog, toast } from '../../components/ui';
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
  const [users, setUsers] = useState<InternalUser[]>([]);
  const reloadRef = useRef<() => void>(() => {});

  // One-time raw key reveal (after create / rotate).
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showConnect, setShowConnect] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  // Create dialog.
  const [creating, setCreating] = useState(false);
  const [draftAppId, setDraftAppId] = useState('');
  const [draftAppName, setDraftAppName] = useState('');
  const [draftUserId, setDraftUserId] = useState('');
  const [saving, setSaving] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<ApiClient | null>(null);

  // Per-key activity.
  const [activityFor, setActivityFor] = useState<ApiClient | null>(null);
  const [activityRows, setActivityRows] = useState<AuditRow[] | null>(null);
  const [activityTotal, setActivityTotal] = useState(0);
  const [activityLoading, setActivityLoading] = useState(false);

  const loadUsers = useCallback(async () => {
    const res = await authFetch('/api/admin/users');
    if (res.ok) {
      const data = await res.json();
      setUsers((data.users as InternalUser[]).filter((u) => u.role === 'super' || u.role === 'team'));
    }
  }, []);

  useEffect(() => {
    void loadUsers();
  }, [loadUsers]);

  const userMap = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);

  useEffect(() => {
    if (revealedKey) setShowConnect(true);
  }, [revealedKey]);

  // ── Data source: list MCP-channel keys ──────────────────
  const dataSource = useMemo<CrudDataSource<ApiClient>>(
    () => ({
      async list() {
        const res = await authFetch('/api/admin/clients');
        if (!res.ok) throw new Error('Failed to load keys');
        const data = await res.json();
        const items = (data.clients as ApiClient[]).filter((c) => c.channel === MCP_CHANNEL);
        return { items, total: items.length };
      },
      async get(id) {
        const res = await authFetch('/api/admin/clients');
        const data = await res.json();
        const found = (data.clients as ApiClient[]).find((c) => c.id === id);
        if (!found) throw new Error('Not found');
        return found;
      },
    }),
    [],
  );

  // ── Mutations ───────────────────────────────────────────
  const openCreate = useCallback(
    (ctx: CrudActionContext) => {
      reloadRef.current = ctx.reload;
      setDraftAppId('');
      setDraftAppName('');
      setDraftUserId(users[0]?.id ?? '');
      setCreating(true);
    },
    [users],
  );

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
      reloadRef.current();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setSaving(false);
    }
  }, [draftAppId, draftAppName, draftUserId]);

  const rotate = useCallback(async (c: ApiClient, ctx: CrudActionContext) => {
    try {
      const res = await authFetch(`/api/admin/clients/${c.id}/rotate-key`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) return toast(data?.error || 'Failed to rotate key', 'error');
      setRevealedKey(data.api_key);
      setCopied(false);
      toast(`Rotated key for ${c.app_name}`, 'success');
      ctx.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

  const toggleStatus = useCallback(async (c: ApiClient, ctx: CrudActionContext) => {
    try {
      const res = await authFetch(`/api/admin/clients/${c.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: c.status === 'active' ? 'disabled' : 'active' }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        return toast(data?.error || 'Failed to update status', 'error');
      }
      ctx.reload();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    }
  }, []);

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

  const schema = useMemo(
    () =>
      defineCrud<ApiClient>({
        name: 'MCP key',
        icon: Key,
        dataSource,
        pageSize: 50,
        emptyMessage: 'No MCP keys yet',
        columns: [
          {
            key: 'app_name',
            label: 'App',
            type: 'custom',
            render: (c) => (
              <div>
                <div className="font-medium text-fg">{c.app_name}</div>
                <div className="font-mono text-[11px] text-fg-faint">{c.app_id}</div>
              </div>
            ),
          },
          {
            key: 'user_id',
            label: 'Bound user',
            type: 'custom',
            responsiveHide: 'md',
            render: (c) => {
              const u = c.user_id ? userMap.get(c.user_id) : undefined;
              return <span className="text-xs text-fg-secondary">{u ? userLabel(u) : (c.user_id ?? '—')}</span>;
            },
          },
          {
            key: 'status',
            label: 'Status',
            type: 'badge',
            width: '6rem',
            badgeMap: { active: 'success', disabled: 'destructive' },
          },
          {
            key: 'rate_limit_rpm',
            label: 'Limits (rpm/rpd)',
            type: 'custom',
            responsiveHide: 'lg',
            render: (c) => (
              <span className="text-xs text-fg-faint">
                {c.rate_limit_rpm}/{c.rate_limit_rpd}
              </span>
            ),
          },
        ],
        pageActions: [
          { key: 'refresh', label: 'Refresh', icon: RefreshCw, onClick: (ctx) => ctx.reload() },
          { key: 'create', label: 'Create key', icon: Plus, onClick: (ctx) => openCreate(ctx) },
        ],
        tableActions: [
          { key: 'activity', label: 'Activity', icon: History, onClick: (c) => openActivity(c) },
          {
            key: 'toggle',
            label: (c) => (c.status === 'active' ? 'Disable' : 'Enable'),
            icon: Ban,
            onClick: (c, ctx) => toggleStatus(c, ctx),
          },
          { key: 'rotate', label: 'Rotate key', icon: RefreshCw, tone: 'warning', onClick: (c, ctx) => rotate(c, ctx) },
          {
            key: 'delete',
            label: 'Delete',
            icon: Trash2,
            tone: 'danger',
            onClick: (c, ctx) => {
              reloadRef.current = ctx.reload;
              setDeleteTarget(c);
            },
          },
        ],
        slots: {
          banner: () => (
            <div className="space-y-3">
              {/* How to connect */}
              <div className="rounded-lg border border-edge bg-surface-raised">
                <button
                  onClick={() => setShowConnect((v) => !v)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-semibold text-fg hover:bg-surface-sunken rounded-lg"
                >
                  <span className="flex items-center gap-1.5">
                    <Globe size={12} className="text-fg-muted" /> How to connect an MCP client
                  </span>
                  {showConnect ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                {showConnect && (
                  <div className="px-3 pb-3 pt-2 space-y-2 border-t border-edge">
                    <p className="text-xs text-fg-muted">
                      Streamable-HTTP MCP server. Paste this into your client config, replacing the key with one from
                      "Create key":
                    </p>
                    <div className="relative">
                      <pre className="text-[11px] leading-relaxed font-mono bg-surface-sunken text-fg-secondary rounded p-2 pr-16 overflow-x-auto">
                        {configJson}
                      </pre>
                      <Button
                        size="sm"
                        variant="secondary"
                        className="absolute top-1.5 right-1.5"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(configJson);
                            setCopiedConfig(true);
                            setTimeout(() => setCopiedConfig(false), 1500);
                          } catch {
                            /* clipboard unavailable */
                          }
                        }}
                      >
                        {copiedConfig ? <Check size={12} /> : null}
                        {copiedConfig ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                    <p className="text-[11px] text-fg-faint break-all">
                      Endpoint <span className="font-mono">{endpoint}</span> · auth{' '}
                      <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>.
                    </p>
                  </div>
                )}
              </div>

              {/* One-time key reveal */}
              {revealedKey && (
                <div className="rounded-lg border border-warning/40 bg-warning/10 p-3">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-warning mb-1">
                    <AlertTriangle size={12} /> Save this key now — it is shown only once.
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 text-xs font-mono text-fg break-all bg-surface-sunken rounded px-2 py-1.5 select-all">
                      {revealedKey}
                    </code>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(revealedKey);
                          setCopied(true);
                          setTimeout(() => setCopied(false), 1500);
                        } catch {
                          /* clipboard unavailable */
                        }
                      }}
                    >
                      {copied ? <Check size={12} /> : null}
                      {copied ? 'Copied' : 'Copy'}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setRevealedKey(null)}>
                      Dismiss
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ),
        },
      }),
    [
      dataSource,
      userMap,
      openCreate,
      toggleStatus,
      rotate,
      openActivity,
      showConnect,
      copiedConfig,
      configJson,
      endpoint,
      revealedKey,
      copied,
    ],
  );

  return (
    <div>
      <CrudPage schema={schema} />

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
            The key inherits this user's tool permissions, narrowed to the MCP-exposed set. Writes still require{' '}
            <span className="font-mono">confirm:true</span> per call.
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
          const target = deleteTarget;
          if (!target) return;
          try {
            const res = await authFetch(`/api/admin/clients/${target.id}`, { method: 'DELETE' });
            if (!res.ok) {
              const data = await res.json().catch(() => ({}));
              toast(data?.error || 'Failed to delete', 'error');
              return;
            }
            toast(`Deleted ${target.app_id}`, 'success');
            reloadRef.current();
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
