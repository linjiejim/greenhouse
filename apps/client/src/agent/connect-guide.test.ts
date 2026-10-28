import { describe, expect, it } from 'vitest';
import { connectionVerdict, gatewayGuide, mcpUrlOf, RECENT_CONNECTION_MS, setupSnippets } from './connect-guide';
import type { GatewayOverview } from '../shared/greenhouse-types';

const URL = 'https://hub.example.com/api/mcp';

describe('connect guide', () => {
  it('uses the station’s MCP address, else this origin + /api/mcp', () => {
    expect(mcpUrlOf({ mcp_url: URL }, 'http://localhost:3000')).toBe(URL);
    expect(mcpUrlOf(null, 'https://hub.example.com/')).toBe(URL);
    expect(mcpUrlOf({ mcp_url: '  ' }, 'https://hub.example.com')).toBe(URL);
  });

  it('gives each client its own setup with the address in it', () => {
    expect(setupSnippets('claude-code', URL)[0]!.code).toBe(`claude mcp add --transport http greenhouse ${URL}`);
    expect(setupSnippets('codex', URL)[0]!.code).toContain('codex mcp login greenhouse');
    expect(JSON.parse(setupSnippets('cursor', URL)[0]!.code)).toEqual({ mcpServers: { greenhouse: { url: URL } } });
    const other = setupSnippets('other', URL);
    expect(other.map((s) => s.kind)).toEqual(['http', 'stdio']);
    expect(JSON.parse(other[1]!.code).mcpServers.greenhouse.args).toEqual(['-y', 'mcp-remote', URL]);
  });

  it('offers the gateway only where the client can use it', () => {
    const gateway: GatewayOverview = {
      enabled: true,
      base_url: 'https://hub.example.com/api/gateway/openai/v1',
      anthropic_base_url: 'https://hub.example.com/api/gateway/anthropic',
      models: [
        { id: 'flash', name: 'Flash', openai: true, anthropic: false },
        { id: 'claude', name: 'Claude', openai: true, anthropic: true },
      ],
      keys: [],
    };
    expect(gatewayGuide('codex', gateway)).toEqual({ kind: 'codex' });
    expect(gatewayGuide('other', { ...gateway, enabled: false })).toEqual({ kind: 'off' });
    const claude = gatewayGuide('claude-code', gateway);
    expect(claude.kind === 'snippet' && claude.code).toContain('ANTHROPIC_MODEL=claude');
    expect(gatewayGuide('claude-code', { ...gateway, models: gateway.models!.slice(0, 1) })).toEqual({
      kind: 'no-anthropic',
    });
    const cursor = gatewayGuide('cursor', gateway);
    expect(cursor.kind === 'snippet' && cursor.code).toContain(
      'OPENAI_BASE_URL=https://hub.example.com/api/gateway/openai/v1',
    );
  });

  it('says whether the chosen client reached the station lately', () => {
    const now = '2026-10-29T10:00:00.000Z';
    const at = (ms: number) => new Date(Date.parse(now) - ms).toISOString();
    const connections = [
      { client_name: 'Claude Code', kind: 'claude-code' as const, last_seen_at: at(60_000) },
      { client_name: 'Cursor', kind: 'cursor' as const, last_seen_at: at(RECENT_CONNECTION_MS + 1) },
      { client_name: 'Codex', kind: 'codex' as const, last_seen_at: null },
    ];
    expect(connectionVerdict({ now, connections }, 'claude-code')).toMatchObject({ kind: 'ok', name: 'Claude Code' });
    expect(connectionVerdict({ now, connections }, 'cursor')).toMatchObject({ kind: 'stale', name: 'Cursor' });
    expect(connectionVerdict({ now, connections }, 'codex')).toEqual({ kind: 'never', name: 'Codex' });
    expect(connectionVerdict({ now, connections: [] }, 'cursor')).toEqual({ kind: 'none' });
    // "Other" counts any client: the most recent one.
    expect(connectionVerdict({ now, connections }, 'other')).toMatchObject({ kind: 'ok', name: 'Claude Code' });
  });
});
