/**
 * External MCP servers — Administration (super only).
 *
 * The CLIENT side of MCP: servers whose tools members reach from chat through
 * the `mcp_call` tool (grant it per member under Users → Permissions →
 * Advanced tools). Not to be confused with "MCP Access", which lists the OAuth
 * clients that call Greenhouse's OWN MCP server.
 *
 * Saving a server connects to it and lists its tools; a server that cannot be
 * reached is still saved (it may just be down) and shows why. The allow-list
 * can only be set once tools are known, so it lives in the edit dialog.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  MCP_SERVER_TRANSPORTS,
  validateMcpServerInput,
  type McpRemoteTool,
  type McpServerTransport,
  type McpServerView,
} from '@greenhouse/types/mcp-servers';
import { defineCrud, CrudPage, type CrudDataSource, type CrudFieldRenderProps } from '../settings/crud';
import { Button, Checkbox, EmptyState, Input, Tag, toast } from '../../components/ui';
import { ModulePage } from '../../components/app/module-page';
import { Plug, Plus, RefreshCw } from '../../lib/icons';
import { formatDate } from '../../lib/utils';
import { useT } from '../../lib/i18n';
import {
  createMcpServer,
  deleteMcpServer,
  fetchMcpServers,
  refreshMcpServer,
  updateMcpServer,
  type McpServerWriteResult,
} from '../../lib/api/mcp-servers';

/** The dialog edits a flat draft; `auth_value` is write-only and never read back. */
interface ServerDraft extends McpServerView, Record<string, unknown> {
  auth_value: string;
}

function toDraft(row: McpServerView): ServerDraft {
  return { ...row, auth_value: '' };
}

function ToolChips({ tools }: { tools: McpRemoteTool[] }) {
  const t = useT();
  if (tools.length === 0) return <span className="text-xs text-fg-faint">—</span>;
  return (
    <div className="flex flex-wrap gap-1">
      {tools.map((tool) => (
        <Tag
          key={tool.name}
          tone={tool.read_only ? 'neutral' : tool.destructive ? 'danger' : 'warning'}
          title={tool.description}
        >
          {tool.name}
          {tool.read_only ? ` · ${t('mcpServers.readOnly')}` : ''}
        </Tag>
      ))}
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

export function McpServersPanel() {
  const t = useT();
  const [refreshingId, setRefreshingId] = useState<number | null>(null);

  const report = useCallback(
    (result: McpServerWriteResult) => {
      if (!result.refresh) return toast(t('mcpServers.saved'), 'success');
      if (result.refresh.ok) {
        return toast(t('mcpServers.connected', { count: result.server.tools.length }), 'success');
      }
      toast(t('mcpServers.unreachable', { error: result.refresh.error ?? '' }), 'error');
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
        const body = {
          slug: String(draft.slug ?? '').trim(),
          name: String(draft.name ?? '').trim(),
          description: draft.description ? String(draft.description) : null,
          url: String(draft.url ?? '').trim(),
          transport: (draft.transport ?? 'streamable_http') as McpServerTransport,
          auth_header: draft.auth_header ? String(draft.auth_header).trim() : null,
          ...(draft.auth_value ? { auth_value: String(draft.auth_value) } : {}),
          enabled: draft.enabled ?? true,
        };
        const problem = validateMcpServerInput(body);
        if (problem) throw new Error(problem);
        const result = await createMcpServer(body);
        report(result);
        return toDraft(result.server);
      },
      async update(id, input) {
        const draft = input as Partial<ServerDraft>;
        const body = {
          name: draft.name !== undefined ? String(draft.name).trim() : undefined,
          description: draft.description ? String(draft.description) : null,
          url: draft.url !== undefined ? String(draft.url).trim() : undefined,
          transport: draft.transport as McpServerTransport | undefined,
          auth_header: draft.auth_header ? String(draft.auth_header).trim() : null,
          // Empty means "keep the stored credential", not "clear it".
          ...(draft.auth_value ? { auth_value: String(draft.auth_value) } : {}),
          enabled: draft.enabled,
          allowed_tools: (draft.allowed_tools as string[] | null | undefined) ?? null,
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
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-fg">{row.name}</span>
                  <code className="rounded bg-surface-muted px-1 py-px text-[10px] text-fg-secondary">{row.slug}</code>
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
            render: (row) =>
              row.last_error ? (
                <Tag tone="danger" truncate maxW="max-w-[260px]">
                  {row.last_error}
                </Tag>
              ) : (
                <Tag tone={row.enabled && row.tools.length > 0 ? 'success' : 'neutral'}>
                  {t('mcpServers.toolCount', {
                    count: row.allowed_tools ? `${row.allowed_tools.length}/${row.tools.length}` : row.tools.length,
                  })}
                </Tag>
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
          },
          {
            key: 'name',
            label: t('mcpServers.name'),
            type: 'text',
            required: true,
            width: 2,
            placeholder: 'Order desk',
          },
          {
            key: 'description',
            label: t('mcpServers.description'),
            type: 'textarea',
            rows: 2,
            help: t('mcpServers.descriptionHelp'),
          },
          { type: 'divider', label: t('mcpServers.connection') },
          {
            key: 'url',
            label: t('mcpServers.url'),
            type: 'url',
            required: true,
            width: 3,
            placeholder: 'https://example.com/mcp',
          },
          {
            key: 'transport',
            label: t('mcpServers.transport'),
            type: 'select',
            width: 1,
            defaultValue: 'streamable_http',
            options: MCP_SERVER_TRANSPORTS.map((value) => ({
              value,
              label: value === 'sse' ? 'SSE (legacy)' : 'Streamable HTTP',
            })),
          },
          {
            key: 'auth_header',
            label: t('mcpServers.authHeader'),
            type: 'text',
            width: 2,
            placeholder: 'Authorization',
          },
          {
            key: 'auth_value',
            label: t('mcpServers.authValue'),
            type: 'custom',
            width: 2,
            help: t('mcpServers.authValueHelp'),
            render: ({ value, onChange, disabled, mode, form }) => (
              <Input
                type="password"
                autoComplete="new-password"
                placeholder={mode === 'edit' && form.has_auth_value ? t('mcpServers.authValueKeep') : 'Bearer …'}
                disabled={disabled}
                value={(value as string) ?? ''}
                onChange={(e) => onChange(e.target.value)}
              />
            ),
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
        ],
        formSize: 'lg',
        access: { canView: false, canAdd: true, canEdit: true, canDelete: true },
        deleteConfirm: (row) => ({
          title: t('mcpServers.deleteTitle'),
          description: t('mcpServers.deleteConfirm', { name: row.name }),
        }),
        tableActions: [
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
          toolbar: (ctx) => (
            <div className="flex items-center gap-3">
              <span className="text-xs text-fg-muted">{t('mcpServers.countLabel', { count: ctx.total })}</span>
              <div className="flex-1" />
              <Button size="sm" onClick={ctx.openCreate} data-testid="mcp-servers-add">
                <Plus size={14} className="mr-1" />
                {t('mcpServers.add')}
              </Button>
            </div>
          ),
          rowExpand: (row) => (
            <div className="space-y-2 px-1 py-2">
              {row.description && <p className="text-xs text-fg-muted">{row.description}</p>}
              <ToolChips tools={row.tools} />
            </div>
          ),
          empty: <EmptyState icon={Plug} title={t('mcpServers.noneTitle')} description={t('mcpServers.noneDesc')} />,
        },
      }),
    [t, dataSource, refreshingId, report],
  );

  return (
    <ModulePage moduleId="admin.mcp-servers" layout="list">
      <CrudPage schema={schema} />
    </ModulePage>
  );
}
