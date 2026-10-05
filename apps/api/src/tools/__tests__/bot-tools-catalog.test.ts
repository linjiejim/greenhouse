/**
 * Guard: Bot tools exist only inside Bots conversations.
 *
 * They are catalogued (feature points, description budget and the permission
 * dialog must see them) but no generic path may build or expose them: no
 * proxy/MCP surface, special construction only, hidden from GET /api/tools
 * and the Agent editor, owned by the `bots` feature point and nothing else.
 */

import { describe, expect, it } from 'vitest';
import { BOT_TOOL_IDS, BOT_TOOL_METAS } from '../../bots/tools/meta.js';
import {
  LAZY_TOOL_IDS,
  MCP_EXPOSED_TOOL_IDS,
  MUTATING_PROXY_ALLOWLIST,
  READONLY_PROXY_ALLOWLIST,
  getToolMeta,
  BUILTIN_AGENT_TOOL_IDS,
  getGlobalToolIds,
} from '../registry.js';
import { FEATURE_POINTS } from '../../platform/feature-points.js';

describe('Bot tool catalog', () => {
  it('pins the Bot tool ids', () => {
    expect([...BOT_TOOL_IDS].sort()).toEqual(
      ['bot_tasks', 'browser', 'computer', 'conversation', 'request_takeover', 'team', 'vault'].sort(),
    );
  });

  it('registers every Bot tool as special-only, never proxied or MCP-exposed', () => {
    for (const id of BOT_TOOL_IDS) {
      const meta = getToolMeta(id);
      expect(meta, id).toBeDefined();
      expect(meta!.context).toBe('bots');
      expect(meta!.surface).toBeUndefined();
      expect(meta!.is_global).toBe(false);
      expect(meta!.builtin).toBeUndefined();
      expect(LAZY_TOOL_IDS.has(id)).toBe(true);
      expect(READONLY_PROXY_ALLOWLIST.has(id)).toBe(false);
      expect(MUTATING_PROXY_ALLOWLIST.has(id)).toBe(false);
      expect(MCP_EXPOSED_TOOL_IDS.has(id)).toBe(false);
      expect(BUILTIN_AGENT_TOOL_IDS.has(id)).toBe(false);
    }
    expect(getGlobalToolIds().some((id) => BOT_TOOL_IDS.includes(id))).toBe(false);
  });

  it('is owned by exactly the bots feature point', () => {
    const owners = FEATURE_POINTS.filter((point) => point.toolIds.some((id) => BOT_TOOL_IDS.includes(id)));
    expect(owners.map((p) => p.key)).toEqual(['bots']);
    expect([...owners[0]!.toolIds].sort()).toEqual([...BOT_TOOL_IDS].sort());
    expect(owners[0]!.flag).toBe('bots');
  });

  it('keeps every description within the per-tool budget', () => {
    for (const meta of BOT_TOOL_METAS) {
      expect(meta.description.length, meta.id).toBeLessThan(1200);
    }
  });
});
