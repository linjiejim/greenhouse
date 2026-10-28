/**
 * Connect an agent (「我」 → 我的 Agent → 连接 Agent), React-free (./connect-guide.test.ts): which
 * MCP client the member uses, the station's MCP address, each client's own setup snippet, the
 * model-gateway snippet for clients that can use it, and what the last-seen check says.
 *
 * Sign-in is OAuth discovery on `<origin>/api/mcp`: a client that speaks Streamable HTTP with OAuth
 * needs only the address; one that speaks only stdio goes through `mcp-remote`. Every snippet is
 * that client's real CLI or config file; nothing here carries a secret.
 */

import type { GatewayOverview } from '../shared/greenhouse-types';

export type AgentClientKind = 'claude-code' | 'codex' | 'cursor' | 'other';

export const AGENT_CLIENTS: readonly AgentClientKind[] = ['claude-code', 'codex', 'cursor', 'other'];

/** "Seen in the last minutes": long enough for a sign-in and a first call. */
export const RECENT_CONNECTION_MS = 10 * 60_000;

/** The MCP address: what the station says, else this station's origin + `/api/mcp`. */
export function mcpUrlOf(overview: { mcp_url?: string | null } | null | undefined, apiBase: string): string {
  const said = overview?.mcp_url?.trim();
  return said || `${apiBase.replace(/\/+$/, '')}/api/mcp`;
}

/** One copyable block: `kind` names its caption, `lang` its highlighting. */
export interface Snippet {
  kind: 'claude-code' | 'claude-app' | 'codex' | 'cursor' | 'http' | 'stdio';
  lang: 'shell' | 'json' | 'text';
  code: string;
}

/** The client's own setup, in the order the member runs it. */
export function setupSnippets(client: AgentClientKind, mcpUrl: string): Snippet[] {
  if (client === 'claude-code')
    return [
      { kind: 'claude-code', lang: 'shell', code: `claude mcp add --transport http greenhouse ${mcpUrl}` },
      { kind: 'claude-app', lang: 'text', code: mcpUrl },
    ];
  if (client === 'codex')
    return [
      { kind: 'codex', lang: 'shell', code: `codex mcp add greenhouse --url ${mcpUrl}\ncodex mcp login greenhouse` },
    ];
  if (client === 'cursor')
    return [
      {
        kind: 'cursor',
        lang: 'json',
        code: JSON.stringify({ mcpServers: { greenhouse: { url: mcpUrl } } }, null, 2),
      },
    ];
  return [
    { kind: 'http', lang: 'text', code: mcpUrl },
    {
      kind: 'stdio',
      lang: 'json',
      code: JSON.stringify(
        { mcpServers: { greenhouse: { command: 'npx', args: ['-y', 'mcp-remote', mcpUrl] } } },
        null,
        2,
      ),
    },
  ];
}

/**
 * The team's models for this client through the gateway, or why not: Codex speaks only the
 * Responses API the gateway does not serve; Claude Code needs an Anthropic-wire model.
 */
export type GatewayGuide =
  | { kind: 'snippet'; lang: 'shell'; code: string }
  | { kind: 'codex' }
  | { kind: 'no-anthropic' }
  | { kind: 'off' };

export function gatewayGuide(client: AgentClientKind, gateway: GatewayOverview): GatewayGuide {
  if (!gateway.enabled) return { kind: 'off' };
  if (client === 'codex') return { kind: 'codex' };
  const models = gateway.models ?? [];
  if (client === 'claude-code') {
    const model = models.find((m) => m.anthropic)?.id;
    if (!model || !gateway.anthropic_base_url) return { kind: 'no-anthropic' };
    return {
      kind: 'snippet',
      lang: 'shell',
      code: [
        `export ANTHROPIC_BASE_URL=${gateway.anthropic_base_url}`,
        'export ANTHROPIC_AUTH_TOKEN=ghgw_…',
        `export ANTHROPIC_MODEL=${model}`,
        `export ANTHROPIC_DEFAULT_SONNET_MODEL=${model}`,
        `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}`,
        'export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
        'claude',
      ].join('\n'),
    };
  }
  const model = models.find((m) => m.openai)?.id ?? 'MODEL_ID';
  return {
    kind: 'snippet',
    lang: 'shell',
    code: [
      `export OPENAI_BASE_URL=${gateway.base_url ?? ''}`,
      'export OPENAI_API_KEY=ghgw_…',
      `# model: ${model}`,
    ].join('\n'),
  };
}

export interface SeenConnection {
  client_name: string;
  kind: AgentClientKind;
  last_seen_at: string | null;
}

/** What "check the connection" says for the chosen client. */
export type ConnectionVerdict =
  | { kind: 'ok'; name: string; at: string }
  | { kind: 'stale'; name: string; at: string }
  | { kind: 'never'; name: string }
  | { kind: 'none' };

export function connectionVerdict(
  check: { now: string; connections: readonly SeenConnection[] },
  client: AgentClientKind,
): ConnectionVerdict {
  const now = Date.parse(check.now);
  const mine = check.connections.filter((entry) => client === 'other' || entry.kind === client);
  const seen = mine
    .filter((entry) => entry.last_seen_at)
    .sort((a, b) => Date.parse(b.last_seen_at!) - Date.parse(a.last_seen_at!));
  const latest = seen[0];
  if (latest && now - Date.parse(latest.last_seen_at!) <= RECENT_CONNECTION_MS)
    return { kind: 'ok', name: latest.client_name, at: latest.last_seen_at! };
  if (latest) return { kind: 'stale', name: latest.client_name, at: latest.last_seen_at! };
  if (mine[0]) return { kind: 'never', name: mine[0].client_name };
  return { kind: 'none' };
}
