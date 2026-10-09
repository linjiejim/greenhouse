/**
 * External MCP servers (connectors) — Administration (super only).
 *
 * The CLIENT side of MCP: servers whose tools members and their Bots reach
 * through the `mcp_call` tool (grant it per member under Users → Permissions →
 * Advanced tools). Not to be confused with "MCP Access", which lists the OAuth
 * clients that call Greenhouse's OWN MCP server.
 *
 * A connector authenticates one of four ways (spec 20261009-mcp-connectors):
 * none, one shared credential, each member's own key, or each member's own
 * OAuth sign-in. For the last two its tools are listed with the acting admin's
 * own connection, so a fresh one offers "Connect my account". Servers come from
 * the official catalog (`connectors/*.json`, vetted), the official MCP Registry
 * (unvetted, prefilled into the form) or a URL typed by hand.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isEffectivelyReadOnly,
  MCP_AUTH_MODES,
  MCP_SERVER_TRANSPORTS,
  validateMcpServerInput,
  type McpAuthMode,
  type McpCatalogEntry,
  type McpProbeResult,
  type McpRegistryResult,
  type McpRemoteTool,
  type McpServerInput,
  type McpServerTransport,
  type McpServerUpdate,
  type McpServerView,
} from '@greenhouse/types/mcp-servers';
import {
  defineCrud,
  CrudPage,
  type CrudActionContext,
  type CrudDataSource,
  type CrudFieldRenderProps,
} from '../settings/crud';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  Input,
  SearchInput,
  Spinner,
  Tabs,
  Tag,
  toast,
} from '../../components/ui';
import { ModulePage } from '../../components/app/module-page';
import { BookOpen, Globe, LogIn, Plug, Plus, RefreshCw } from '../../lib/icons';
import { formatDate } from '../../lib/utils';
import { useI18n, useT } from '../../lib/i18n';
import {
  createMcpServer,
  deleteMcpServer,
  fetchConnectorCatalog,
  fetchMcpServers,
  installCatalogEntry,
  probeMcpServer,
  refreshMcpServer,
  searchMcpRegistry,
  updateMcpServer,
  type McpServerWriteResult,
} from '../../lib/api/mcp-servers';
import { signInToConnector } from '../../lib/connector-sign-in';

type Placement = 'header' | 'query';

/** The dialog edits a flat draft; secrets are write-only and never read back. */
interface ServerDraft extends McpServerView, Record<string, unknown> {
  auth_value: string;
  oauth_client_id_input: string;
  oauth_client_secret: string;
  placement: Placement;
}

function toDraft(row: McpServerView): ServerDraft {
  return {
    ...row,
    auth_value: '',
    oauth_client_id_input: row.oauth_client?.source === 'manual' ? row.oauth_client.client_id : '',
    oauth_client_secret: '',
    placement: row.auth_query_param ? 'query' : 'header',
  };
}

const PERSONAL: ReadonlySet<McpAuthMode> = new Set(['per_user', 'oauth']);
const takesCredential = (form: Record<string, unknown>) => form.auth_mode === 'shared' || form.auth_mode === 'per_user';

/** Where the credential goes, from the draft's placement switch. */
function placementFields(draft: Partial<ServerDraft>): Pick<McpServerInput, 'auth_header' | 'auth_query_param'> {
  if (!takesCredential(draft)) return { auth_header: null, auth_query_param: null };
  return draft.placement === 'query'
    ? { auth_header: null, auth_query_param: String(draft.auth_query_param ?? '').trim() || null }
    : { auth_header: String(draft.auth_header ?? '').trim() || 'Authorization', auth_query_param: null };
}

function ToolChips({ tools, vouched }: { tools: McpRemoteTool[]; vouched: string[] | null }) {
  const t = useT();
  if (tools.length === 0) return <span className="text-xs text-fg-faint">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {tools.map((tool) => {
        const readOnly = isEffectivelyReadOnly(tool, vouched);
        return (
          <Tag
            key={tool.name}
            tone={readOnly ? 'neutral' : tool.destructive ? 'danger' : 'warning'}
            title={tool.description}
          >
            {tool.name}
            {tool.read_only ? ` · ${t('mcpServers.readOnly')}` : readOnly ? ` · ${t('mcpServers.vouched')}` : ''}
          </Tag>
        );
      })}
    </div>
  );
}

/** Checkboxes over the discovered tools; every box ticked is stored as "all" (null). */
function AllowedToolsField({ value, onChange, form, disabled }: CrudFieldRenderProps) {
  const t = useT();
  const tools = (form.tools as McpRemoteTool[] | undefined) ?? [];
  if (tools.length === 0) {
    return <p className="text-xs text-fg-muted">{t('mcpServers.allowedToolsNone')}</p>;
  }
  const allowed =
    value === null || value === undefined ? new Set(tools.map((tool) => tool.name)) : new Set(value as string[]);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(allowed);
    if (on) next.add(name);
    else next.delete(name);
    onChange(next.size === tools.length ? null : tools.map((tool) => tool.name).filter((n) => next.has(n)));
  };
  return (
    <div className="space-y-1.5">
      {tools.map((tool) => (
        <Checkbox
          key={tool.name}
          disabled={disabled}
          checked={allowed.has(tool.name)}
          onChange={(e) => toggle(tool.name, e.target.checked)}
          label={
            <span className="flex min-w-0 items-center gap-2">
              <code className="text-xs">{tool.name}</code>
              <Tag tone={tool.read_only ? 'neutral' : 'warning'}>
                {tool.read_only ? t('mcpServers.readOnly') : t('mcpServers.needsConfirm')}
              </Tag>
              <span className="truncate text-xs text-fg-muted">{tool.description}</span>
            </span>
          }
        />
      ))}
    </div>
  );
}

/** The tools the server did NOT declare read-only, to vouch for (spec D10). */
function ReadOnlyToolsField({ value, onChange, form, disabled }: CrudFieldRenderProps) {
  const t = useT();
  const candidates = ((form.tools as McpRemoteTool[] | undefined) ?? []).filter((tool) => !tool.read_only);
  if (candidates.length === 0) {
    return <p className="text-xs text-fg-muted">—</p>;
  }
  const vouched = new Set((value as string[] | null | undefined) ?? []);
  const toggle = (name: string, on: boolean) => {
    const next = new Set(vouched);
    if (on) next.add(name);
    else next.delete(name);
    onChange(next.size === 0 ? null : [...next]);
  };
  return (
    <div className="space-y-1.5">
      {candidates.map((tool) => (
        <Checkbox
          key={tool.name}
          disabled={disabled || tool.destructive}
          checked={vouched.has(tool.name) && !tool.destructive}
          onChange={(e) => toggle(tool.name, e.target.checked)}
          label={
            <span className="flex min-w-0 items-center gap-2">
              <code className="text-xs">{tool.name}</code>
              {tool.destructive && <Tag tone="danger">{t('mcpServers.destructive')}</Tag>}
              <span className="truncate text-xs text-fg-muted">{tool.description}</span>
            </span>
          }
        />
      ))}
      <p className="text-[11px] text-fg-faint">{t('mcpServers.readOnlyToolsHelp')}</p>
    </div>
  );
}

/** "Detect": ask the address what it wants before picking a sign-in mode. */
function DetectField({ form }: CrudFieldRenderProps) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpProbeResult | null>(null);
  const url = String(form.url ?? '').trim();
  const detect = async () => {
    setBusy(true);
    try {
      setResult(await probeMcpServer(url, (form.transport as McpServerTransport | undefined) ?? 'streamable_http'));
    } catch (err) {
      setResult({ auth: 'unknown', error: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };
  const describe = (r: McpProbeResult) => {
    switch (r.auth) {
      case 'none':
        return t('mcpServers.detectNone', { count: r.tool_count ?? 0 });
      case 'oauth':
        return t('mcpServers.detectOauth', {
          extra:
            r.dynamic_registration || r.metadata_document
              ? t('mcpServers.detectOauthDcr')
              : t('mcpServers.detectOauthManual'),
        });
      case 'key':
        return t('mcpServers.detectKey');
      default:
        return t('mcpServers.detectUnknown', { error: r.error ?? '' });
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="outline" disabled={!url || busy} onClick={detect} data-testid="mcp-servers-detect">
        {busy ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : <Globe size={13} className="mr-1.5" />}
        {busy ? t('mcpServers.detecting') : t('mcpServers.detect')}
      </Button>
      {result && (
        <span className={`text-xs ${result.auth === 'unknown' ? 'text-danger' : 'text-fg-secondary'}`}>
          {describe(result)}
        </span>
      )}
    </div>
  );
}

function authBadge(t: ReturnType<typeof useT>, mode: McpAuthMode): string {
  switch (mode) {
    case 'oauth':
      return t('mcpServers.authBadgeOauth');
    case 'per_user':
      return t('mcpServers.authBadgePerUser');
    case 'shared':
      return t('mcpServers.authBadgeShared');
    default:
      return t('mcpServers.authBadgeNone');
  }
}

// ─── Add from catalog / Registry ─────────────────────────

function verificationLabel(t: ReturnType<typeof useT>, entry: McpCatalogEntry): string {
  switch (entry.verification.level) {
    case 'call':
      return t('mcpServers.verifiedCall');
    case 'sign_in':
      return t('mcpServers.verifiedSignIn');
    default:
      return t('mcpServers.verifiedHandshake');
  }
}

function CatalogDialog({
  onClose,
  onInstalled,
  onUseRegistry,
}: {
  onClose: () => void;
  onInstalled: () => void;
  onUseRegistry: (result: McpRegistryResult) => void;
}) {
  const t = useT();
  const { locale } = useI18n();
  const [tab, setTab] = useState<'catalog' | 'registry'>('catalog');
  const [entries, setEntries] = useState<McpCatalogEntry[] | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<McpRegistryResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);

  const loadCatalog = useCallback(async () => {
    try {
      setEntries(await fetchConnectorCatalog());
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
      setEntries([]);
    }
  }, []);
  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const install = async (entry: McpCatalogEntry) => {
    setInstalling(entry.id);
    try {
      const result = await installCatalogEntry(entry.id);
      toast(t('mcpServers.installedToast', { name: entry.title }), 'success');
      if (result.refresh && !result.refresh.ok && !PERSONAL.has(entry.auth.mode)) {
        toast(t('mcpServers.unreachable', { error: result.refresh.error ?? '' }), 'error');
      }
      onInstalled();
      await loadCatalog();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setInstalling(null);
    }
  };

  const runSearch = async () => {
    setSearching(true);
    setRegistryError(null);
    try {
      const found = await searchMcpRegistry(search.trim());
      setResults(found.results);
      setRegistryError(found.error);
    } catch (err) {
      setRegistryError(err instanceof Error ? err.message : String(err));
      setResults([]);
    } finally {
      setSearching(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={t('mcpServers.catalogTitle')}
      size="xl"
      tabs={
        <Tabs
          tabs={[
            { key: 'catalog', label: t('mcpServers.catalogTab') },
            { key: 'registry', label: t('mcpServers.registryTab') },
          ]}
          active={tab}
          onChange={(key) => setTab(key as 'catalog' | 'registry')}
        />
      }
    >
      {tab === 'catalog' ? (
        <div className="space-y-3" data-testid="mcp-catalog">
          <p className="text-xs text-fg-muted">{t('mcpServers.catalogIntro')}</p>
          {!entries ? (
            <div className="flex justify-center py-8">
              <Spinner />
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {entries.map((entry) => (
                <div
                  key={entry.id}
                  className="flex flex-col rounded-xl border border-edge bg-surface-card p-3"
                  data-testid={`catalog-entry-${entry.slug}`}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium text-fg">
                          {locale === 'zh' && entry.title_zh ? entry.title_zh : entry.title}
                        </span>
                        <Tag tone="neutral">{authBadge(t, entry.auth.mode)}</Tag>
                        {entry.auth.zero_config ? (
                          <Tag tone="success">{t('mcpServers.zeroConfig')}</Tag>
                        ) : (
                          <Tag tone="warning">{t('mcpServers.needsClient')}</Tag>
                        )}
                      </div>
                      <code className="text-[10px] text-fg-faint">{entry.id}</code>
                    </div>
                  </div>
                  <p className="mt-1.5 flex-1 text-xs text-fg-muted">
                    {locale === 'zh' ? entry.description_zh : entry.description}
                  </p>
                  <div className="mt-2 flex items-center gap-2">
                    <span className="text-[11px] text-fg-faint" title={entry.verification.notes}>
                      {verificationLabel(t, entry)} · {entry.verification.date}
                    </span>
                    <div className="flex-1" />
                    {entry.installed_slug ? (
                      <span className="text-xs text-fg-secondary">
                        {t('mcpServers.installed', { slug: entry.installed_slug })}
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        disabled={installing !== null}
                        onClick={() => install(entry)}
                        data-testid={`catalog-install-${entry.slug}`}
                      >
                        {installing === entry.id ? <Spinner className="mr-1.5 h-3.5 w-3.5" /> : null}
                        {installing === entry.id ? t('mcpServers.installing') : t('mcpServers.install')}
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-3" data-testid="mcp-registry">
          <p className="text-xs text-fg-muted">{t('mcpServers.registryIntro')}</p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void runSearch();
            }}
          >
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder={t('mcpServers.registrySearch')}
              className="flex-1"
            />
            <Button size="sm" type="submit" disabled={searching}>
              {searching ? <Spinner className="h-3.5 w-3.5" /> : <Globe size={14} />}
            </Button>
          </form>
          {searching && <p className="text-xs text-fg-faint">{t('mcpServers.registrySlow')}</p>}
          {registryError && <p className="text-xs text-danger">{registryError}</p>}
          {results && results.length === 0 && !registryError && (
            <p className="text-xs text-fg-faint">{t('mcpServers.registryEmpty')}</p>
          )}
          <div className="space-y-2">
            {(results ?? []).map((result) => (
              <div key={result.name} className="rounded-lg border border-edge bg-surface-card p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-fg">{result.title ?? result.name}</span>
                  <code className="text-[10px] text-fg-faint">
                    {result.name} · v{result.version}
                  </code>
                  <div className="flex-1" />
                  {result.catalog_id ? (
                    <Tag tone="success">{t('mcpServers.registryInCatalog')}</Tag>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => onUseRegistry(result)}>
                      {t('mcpServers.registryUse')}
                    </Button>
                  )}
                </div>
                <p className="mt-1 text-xs text-fg-muted">{result.description}</p>
                <p className="mt-1 truncate font-mono text-[11px] text-fg-faint">{result.remotes[0]?.url}</p>
                {result.remotes[0] && result.remotes[0].headers.length > 0 && (
                  <p className="mt-0.5 text-[11px] text-fg-faint">
                    {t('mcpServers.registryHeaders', {
                      headers: result.remotes[0].headers.map((h) => h.name).join(', '),
                    })}
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}

/** A Registry entry as a draft for the ordinary form: the admin reviews and saves it. */
function draftFromRegistry(result: McpRegistryResult): Partial<ServerDraft> {
  const remote = result.remotes.find((r) => r.transport === 'streamable_http') ?? result.remotes[0]!;
  const secretHeader = remote.headers.find((h) => h.secret || h.required);
  const base = result.name.split('/').pop() ?? result.name;
  const slug =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .slice(0, 32) || 'server';
  return {
    slug,
    name: (result.title ?? base).slice(0, 80),
    description: result.description.slice(0, 500),
    url: remote.url,
    transport: remote.transport,
    auth_mode: secretHeader ? 'per_user' : 'none',
    placement: 'header',
    auth_header: secretHeader?.name ?? 'Authorization',
    ...(secretHeader?.description ? { credential_help: secretHeader.description.slice(0, 500) } : {}),
  };
}

export function McpServersPanel() {
  const t = useT();
  const [refreshingId, setRefreshingId] = useState<number | null>(null);
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [prefill, setPrefill] = useState<Partial<ServerDraft> | null>(null);
  const ctxRef = useRef<CrudActionContext | null>(null);
  const openAfterPrefill = useRef(false);

  // Open the create form only after the schema carrying the prefill rendered.
  useEffect(() => {
    if (prefill && openAfterPrefill.current) {
      openAfterPrefill.current = false;
      ctxRef.current?.openCreate();
    }
  }, [prefill]);

  const report = useCallback(
    (result: McpServerWriteResult) => {
      if (!result.refresh) return toast(t('mcpServers.saved'), 'success');
      if (result.refresh.ok) {
        return toast(t('mcpServers.connected', { count: result.server.tools.length }), 'success');
      }
      if (PERSONAL.has(result.server.auth_mode)) return toast(t('mcpServers.savedPersonal'), 'info');
      toast(t('mcpServers.unreachable', { error: result.refresh.error ?? '' }), 'error');
    },
    [t],
  );

  const connectMine = useCallback(
    async (row: ServerDraft, ctx: CrudActionContext) => {
      if (row.auth_mode === 'per_user') {
        window.location.hash = `#/settings/connectors?connect=${row.id}`;
        return;
      }
      try {
        const outcome = await signInToConnector(row.id);
        if (outcome === 'connected') toast(t('connectors.connectedToast', { name: row.name }), 'success');
        else if (outcome === 'failed') toast(t('connectors.signInFailed'), 'error');
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        ctx.reload();
      }
    },
    [t],
  );

  const dataSource = useMemo<CrudDataSource<ServerDraft>>(
    () => ({
      async list() {
        const servers = await fetchMcpServers();
        return { items: servers.map(toDraft), total: servers.length };
      },
      async create(input) {
        const draft = input as Partial<ServerDraft>;
        const authMode = (draft.auth_mode ?? 'none') as McpAuthMode;
        const body: McpServerInput = {
          slug: String(draft.slug ?? '').trim(),
          name: String(draft.name ?? '').trim(),
          description: draft.description ? String(draft.description) : null,
          url: String(draft.url ?? '').trim(),
          transport: (draft.transport ?? 'streamable_http') as McpServerTransport,
          auth_mode: authMode,
          ...placementFields(draft),
          auth_value_prefix: takesCredential(draft)
            ? draft.auth_value_prefix
              ? String(draft.auth_value_prefix)
              : null
            : null,
          ...(authMode === 'shared' && draft.auth_value ? { auth_value: String(draft.auth_value) } : {}),
          credential_help: authMode === 'per_user' && draft.credential_help ? String(draft.credential_help) : null,
          credential_url: authMode === 'per_user' && draft.credential_url ? String(draft.credential_url) : null,
          oauth_scope: authMode === 'oauth' && draft.oauth_scope ? String(draft.oauth_scope) : null,
          ...(authMode === 'oauth' && draft.oauth_client_id_input
            ? {
                oauth_client_id: String(draft.oauth_client_id_input).trim(),
                ...(draft.oauth_client_secret ? { oauth_client_secret: String(draft.oauth_client_secret) } : {}),
              }
            : {}),
          enabled: draft.enabled ?? true,
        };
        const problem = validateMcpServerInput(body);
        if (problem) throw new Error(problem);
        const result = await createMcpServer(body);
        setPrefill(null);
        report(result);
        return toDraft(result.server);
      },
      async update(id, input) {
        const draft = input as Partial<ServerDraft>;
        const authMode = (draft.auth_mode ?? 'none') as McpAuthMode;
        const body: McpServerUpdate = {
          name: draft.name !== undefined ? String(draft.name).trim() : undefined,
          description: draft.description ? String(draft.description) : null,
          url: draft.url !== undefined ? String(draft.url).trim() : undefined,
          transport: draft.transport as McpServerTransport | undefined,
          auth_mode: authMode,
          ...placementFields(draft),
          auth_value_prefix: takesCredential(draft)
            ? draft.auth_value_prefix
              ? String(draft.auth_value_prefix)
              : null
            : null,
          // Empty means "keep the stored credential", not "clear it".
          ...(authMode === 'shared' && draft.auth_value ? { auth_value: String(draft.auth_value) } : {}),
          credential_help: authMode === 'per_user' && draft.credential_help ? String(draft.credential_help) : null,
          credential_url: authMode === 'per_user' && draft.credential_url ? String(draft.credential_url) : null,
          oauth_scope: authMode === 'oauth' && draft.oauth_scope ? String(draft.oauth_scope) : null,
          ...(authMode === 'oauth'
            ? {
                oauth_client_id: draft.oauth_client_id_input ? String(draft.oauth_client_id_input).trim() : null,
                ...(draft.oauth_client_secret ? { oauth_client_secret: String(draft.oauth_client_secret) } : {}),
              }
            : {}),
          enabled: draft.enabled,
          allowed_tools: (draft.allowed_tools as string[] | null | undefined) ?? null,
          read_only_tools: (draft.read_only_tools as string[] | null | undefined) ?? null,
        };
        const problem = validateMcpServerInput(body, { partial: true });
        if (problem) throw new Error(problem);
        const result = await updateMcpServer(Number(id), body);
        report(result);
        return toDraft(result.server);
      },
      async remove(id) {
        await deleteMcpServer(Number(id));
      },
    }),
    [report],
  );

  const callbackUrl = `${window.location.origin}/api/connectors/oauth/callback`;

  const schema = useMemo(
    () =>
      defineCrud<ServerDraft>({
        name: t('mcpServers.entity'),
        testId: 'mcp-servers',
        dataSource,
        idField: 'id',
        icon: Plug,
        columns: [
          {
            key: 'slug',
            label: t('mcpServers.server'),
            type: 'custom',
            render: (row) => (
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-fg">{row.name}</span>
                  <code className="rounded bg-surface-muted px-1 py-px text-[10px] text-fg-secondary">{row.slug}</code>
                  <Tag tone="neutral">{authBadge(t, row.auth_mode)}</Tag>
                  {row.catalog_id && (
                    <span title={row.catalog_id} className="inline-flex items-center text-fg-faint">
                      <BookOpen size={11} />
                    </span>
                  )}
                </div>
                <div className="truncate font-mono text-[11px] text-fg-faint" title={row.url}>
                  {row.url}
                </div>
              </div>
            ),
          },
          {
            key: 'enabled',
            label: t('mcpServers.enabled'),
            type: 'toggle',
            width: '90px',
            onToggle: async (row, next) => {
              report(await updateMcpServer(row.id, { enabled: next }));
            },
          },
          {
            key: 'status',
            label: t('mcpServers.status'),
            type: 'custom',
            render: (row) => (
              <div className="flex flex-col items-start gap-1">
                {row.last_error ? (
                  <Tag tone="danger" truncate maxW="max-w-[260px]">
                    {row.last_error}
                  </Tag>
                ) : row.tools.length === 0 && PERSONAL.has(row.auth_mode) ? (
                  <Tag tone="warning">
                    {row.auth_mode === 'oauth' ? t('mcpServers.needsSignIn') : t('mcpServers.needsKey')}
                  </Tag>
                ) : (
                  <Tag tone={row.enabled && row.tools.length > 0 ? 'success' : 'neutral'}>
                    {t('mcpServers.toolCount', {
                      count: row.allowed_tools ? `${row.allowed_tools.length}/${row.tools.length}` : row.tools.length,
                    })}
                  </Tag>
                )}
                {PERSONAL.has(row.auth_mode) && (
                  <span className="text-[11px] text-fg-faint">
                    {t('mcpServers.connections', { count: row.connection_count })}
                  </span>
                )}
              </div>
            ),
          },
          {
            key: 'tools_refreshed_at',
            label: t('mcpServers.refreshedAt'),
            type: 'custom',
            responsiveHide: 'md',
            render: (row) => (
              <span className="text-xs text-fg-muted">
                {row.tools_refreshed_at ? formatDate(row.tools_refreshed_at) : '—'}
              </span>
            ),
          },
        ],
        formFields: [
          {
            key: 'slug',
            label: t('mcpServers.slug'),
            type: 'text',
            required: true,
            width: 2,
            placeholder: 'orders',
            help: t('mcpServers.slugHelp'),
            allows: { add: true, edit: false },
            ...(prefill?.slug ? { defaultValue: prefill.slug } : {}),
          },
          {
            key: 'name',
            label: t('mcpServers.name'),
            type: 'text',
            required: true,
            width: 2,
            placeholder: 'Order desk',
            ...(prefill?.name ? { defaultValue: prefill.name } : {}),
          },
          {
            key: 'description',
            label: t('mcpServers.description'),
            type: 'textarea',
            rows: 2,
            help: t('mcpServers.descriptionHelp'),
            ...(prefill?.description ? { defaultValue: prefill.description } : {}),
          },
          { type: 'divider', label: t('mcpServers.connection') },
          {
            key: 'url',
            label: t('mcpServers.url'),
            type: 'url',
            required: true,
            width: 3,
            placeholder: 'https://example.com/mcp',
            ...(prefill?.url ? { defaultValue: prefill.url } : {}),
          },
          {
            key: 'transport',
            label: t('mcpServers.transport'),
            type: 'select',
            width: 1,
            defaultValue: prefill?.transport ?? 'streamable_http',
            options: MCP_SERVER_TRANSPORTS.map((value) => ({
              value,
              label: value === 'sse' ? 'SSE (legacy)' : 'Streamable HTTP',
            })),
          },
          {
            key: 'detect',
            label: '',
            type: 'custom',
            render: (props) => <DetectField {...props} />,
          },
          {
            key: 'auth_mode',
            label: t('mcpServers.authMode'),
            type: 'select',
            help: t('mcpServers.authModeHelp'),
            defaultValue: prefill?.auth_mode ?? 'none',
            options: MCP_AUTH_MODES.map((value) => ({
              value,
              label:
                value === 'none'
                  ? t('mcpServers.authModeNone')
                  : value === 'shared'
                    ? t('mcpServers.authModeShared')
                    : value === 'per_user'
                      ? t('mcpServers.authModePerUser')
                      : t('mcpServers.authModeOauth'),
            })),
          },
          {
            key: 'placement',
            label: t('mcpServers.placement'),
            type: 'select',
            width: 2,
            defaultValue: prefill?.placement ?? 'header',
            visible: takesCredential,
            options: [
              { value: 'header', label: t('mcpServers.placementHeader') },
              { value: 'query', label: t('mcpServers.placementQuery') },
            ],
          },
          {
            key: 'auth_header',
            label: t('mcpServers.authHeader'),
            type: 'text',
            width: 2,
            placeholder: 'Authorization',
            visible: (form) => takesCredential(form) && form.placement !== 'query',
            ...(prefill?.auth_header ? { defaultValue: prefill.auth_header } : {}),
          },
          {
            key: 'auth_query_param',
            label: t('mcpServers.authQueryParam'),
            type: 'text',
            width: 2,
            placeholder: 'key',
            visible: (form) => takesCredential(form) && form.placement === 'query',
          },
          {
            key: 'auth_value_prefix',
            label: t('mcpServers.authValuePrefix'),
            type: 'text',
            width: 2,
            placeholder: 'Bearer ',
            help: t('mcpServers.authValuePrefixHelp'),
            visible: takesCredential,
          },
          {
            key: 'auth_value',
            label: t('mcpServers.authValue'),
            type: 'custom',
            width: 2,
            help: t('mcpServers.authValueHelp'),
            visible: (form) => form.auth_mode === 'shared',
            render: ({ value, onChange, disabled, mode, form }) => (
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={mode === 'edit' && form.has_auth_value ? t('mcpServers.authValueKeep') : '…'}
                disabled={disabled}
                value={(value as string) ?? ''}
                onChange={(e) => onChange(e.target.value)}
              />
            ),
          },
          {
            key: 'credential_help',
            label: t('mcpServers.credentialHelp'),
            type: 'text',
            help: t('mcpServers.credentialHelpHelp'),
            visible: (form) => form.auth_mode === 'per_user',
            ...(prefill?.credential_help ? { defaultValue: prefill.credential_help } : {}),
          },
          {
            key: 'credential_url',
            label: t('mcpServers.credentialUrl'),
            type: 'url',
            visible: (form) => form.auth_mode === 'per_user',
          },
          {
            key: 'oauth_scope',
            label: t('mcpServers.oauthScope'),
            type: 'text',
            width: 2,
            help: t('mcpServers.oauthScopeHelp'),
            visible: (form) => form.auth_mode === 'oauth',
          },
          {
            key: 'oauth_client_id_input',
            label: t('mcpServers.oauthClientId'),
            type: 'text',
            width: 2,
            help: t('mcpServers.oauthClientIdHelp', { callback: callbackUrl }),
            visible: (form) => form.auth_mode === 'oauth',
          },
          {
            key: 'oauth_client_secret',
            label: t('mcpServers.oauthClientSecret'),
            type: 'custom',
            width: 2,
            visible: (form) => form.auth_mode === 'oauth' && Boolean(form.oauth_client_id_input),
            render: ({ value, onChange, disabled, form }) => (
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={
                  (form.oauth_client as McpServerView['oauth_client'])?.has_secret
                    ? t('mcpServers.oauthClientSecretKeep')
                    : ''
                }
                disabled={disabled}
                value={(value as string) ?? ''}
                onChange={(e) => onChange(e.target.value)}
              />
            ),
          },
          {
            key: 'oauth_client',
            label: '',
            type: 'custom',
            allows: { add: false, edit: true },
            visible: (form) => form.auth_mode === 'oauth' && Boolean(form.oauth_client),
            render: ({ form }) => {
              const client = form.oauth_client as McpServerView['oauth_client'];
              if (!client) return null;
              const source =
                client.source === 'dynamic'
                  ? t('mcpServers.oauthSourceDynamic')
                  : client.source === 'metadata_document'
                    ? t('mcpServers.oauthSourceMetadata')
                    : t('mcpServers.oauthSourceManual');
              return (
                <p className="text-[11px] text-fg-faint">
                  {t('mcpServers.oauthClient', { source, id: client.client_id.slice(0, 48) })}
                </p>
              );
            },
          },
          { key: 'enabled', label: t('mcpServers.enabled'), type: 'switch', defaultValue: true },
          {
            key: 'allowed_tools',
            label: t('mcpServers.allowedTools'),
            type: 'custom',
            help: t('mcpServers.allowedToolsHelp'),
            allows: { add: false, edit: true },
            render: (props) => <AllowedToolsField {...props} />,
          },
          {
            key: 'read_only_tools',
            label: t('mcpServers.readOnlyTools'),
            type: 'custom',
            allows: { add: false, edit: true },
            render: (props) => <ReadOnlyToolsField {...props} />,
          },
        ],
        formSize: 'lg',
        access: { canView: false, canAdd: true, canEdit: true, canDelete: true },
        deleteConfirm: (row) => ({
          title: t('mcpServers.deleteTitle'),
          description: t('mcpServers.deleteConfirm', { name: row.name }),
        }),
        tableActions: [
          {
            key: 'connect',
            label: t('mcpServers.connectMine'),
            icon: LogIn,
            tone: 'primary',
            visible: (row) => PERSONAL.has(row.auth_mode) && row.enabled,
            onClick: (row, ctx) => connectMine(row, ctx),
          },
          {
            key: 'refresh',
            label: t('mcpServers.refresh'),
            icon: RefreshCw,
            tone: 'primary',
            onClick: async (row, ctx) => {
              if (refreshingId === row.id) return;
              setRefreshingId(row.id);
              try {
                report(await refreshMcpServer(row.id));
                ctx.reload();
              } catch (err) {
                toast(err instanceof Error ? err.message : String(err), 'error');
              } finally {
                setRefreshingId(null);
              }
            },
          },
        ],
        slots: {
          banner: () => (
            <div className="rounded-lg border border-edge bg-surface-muted px-3 py-2 text-xs text-fg-muted">
              {t('mcpServers.banner')}
            </div>
          ),
          toolbar: (ctx) => {
            ctxRef.current = ctx;
            return (
              <div className="flex items-center gap-3">
                <span className="text-xs text-fg-muted">{t('mcpServers.countLabel', { count: ctx.total })}</span>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setCatalogOpen(true)}
                  data-testid="mcp-servers-catalog"
                >
                  <BookOpen size={14} className="mr-1" />
                  {t('mcpServers.fromCatalog')}
                </Button>
                <Button
                  size="sm"
                  onClick={() => {
                    setPrefill(null);
                    ctx.openCreate();
                  }}
                  data-testid="mcp-servers-add"
                >
                  <Plus size={14} className="mr-1" />
                  {t('mcpServers.add')}
                </Button>
              </div>
            );
          },
          rowExpand: (row) => (
            <div className="space-y-2 px-1 py-2">
              {row.description && <p className="text-xs text-fg-muted">{row.description}</p>}
              <ToolChips tools={row.tools} vouched={row.read_only_tools} />
            </div>
          ),
          empty: <EmptyState icon={Plug} title={t('mcpServers.noneTitle')} description={t('mcpServers.noneDesc')} />,
        },
      }),
    [t, dataSource, refreshingId, report, prefill, connectMine, callbackUrl],
  );

  return (
    <ModulePage moduleId="admin.mcp-servers" layout="list">
      <CrudPage schema={schema} />
      {catalogOpen && (
        <CatalogDialog
          onClose={() => setCatalogOpen(false)}
          onInstalled={() => ctxRef.current?.reload()}
          onUseRegistry={(result) => {
            setCatalogOpen(false);
            openAfterPrefill.current = true;
            setPrefill(draftFromRegistry(result));
          }}
        />
      )}
    </ModulePage>
  );
}
