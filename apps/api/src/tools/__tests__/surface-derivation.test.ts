/**
 * Guard test for the derived proxy/MCP exposure sets (ported from OSS greenhouse).
 *
 * The allowlists are DERIVED from each tool's declarative `meta.surface` —
 * this test pins the exact expected memberships so an accidental exposure
 * change (adding `surface` to a sensitive tool, typo'ing a tier, dropping a
 * field during refactor) fails CI instead of silently widening /api/agent or
 * /api/mcp. The pinned sets below are 1:1 with the hand-maintained lists this
 * derivation replaced (2026-07 B5) — any intentional change must edit BOTH the
 * tool's meta and this test.
 *
 * The pinned sets cover the CORE tools only: a fork compiles its own extensions
 * into the same registry, and a guard that failed the moment it did would be a
 * guard nobody could keep. The invariants below (a group per MCP tool, tiers
 * disjoint, MCP ⊆ proxy, default-deny) run over the FULL set, extensions
 * included — that is where an accidental exposure would actually show up.
 */

import { describe, it, expect } from 'vitest';
import { allMcpResourceGroups } from '@greenhouse/types/mcp';
import {
  READONLY_PROXY_ALLOWLIST,
  MUTATING_PROXY_ALLOWLIST,
  MCP_EXPOSED_TOOL_IDS,
  MCP_TOOL_IDS_BY_GROUP,
  LAZY_TOOL_IDS,
  TOOL_DEFINITIONS,
  CORE_TOOL_IDS,
} from '../registry.js';

const sorted = (s: Set<string>) => [...s].sort();
/** The pinned expectations describe core; extensions are covered by the invariants. */
const core = (s: Set<string> | ReadonlySet<string>) => [...s].filter((id) => CORE_TOOL_IDS.has(id)).sort();

describe('surface-derived exposure sets', () => {
  it('READONLY_PROXY_ALLOWLIST matches the pinned read surface', () => {
    expect(core(READONLY_PROXY_ALLOWLIST)).toEqual(
      [
        'external_search',
        'compute',
        'analyze_image',
        'session_query',
        // 2026-08-03: Automations (scheduled tasks) — the model can inspect and
        // manage the user's own schedules; owner scoping is inside the tools.
        'automation_query',
        // 2026-08-05: mailbox reading returns after the 0.18.0 removal. Read is
        // safe to expose broadly; the write half is confirm-gated below.
        // v1.5: the team's file cabinet (Files), authorized per node by drive access.
        'files_query',
        // v1.5: a member's own feature requests and their answers (Issues & requests).
        // v1.6: the paid web services members' agents use (MCP group `services`).
        'web_search',
        'read_url',
        // v1.6: list / read files in the member's own cloud computer.
        // v1.7: the team's report templates (list / get / validate — no side effects).
        // v3: connectors. The read tier keeps the `connectors` group reachable for
        // read-only grants; mcp_call governs its own writes (policy, preview,
        // recording) and is filtered out of the /api/agent CLI proxy.
        'mcp_call',
      ].sort(),
    );
  });

  it('MUTATING_PROXY_ALLOWLIST matches the pinned write surface (confirm-gated)', () => {
    expect(core(MUTATING_PROXY_ALLOWLIST)).toEqual(
      [
        'automation_mutation',
        'files_mutation',
        // v1.5: members' agents file requests and report frictions as recorded writes.
        // v1.6: an external agent's image is a new file in the member's Files —
        // a recorded, additive write (Chat still renders it inline).
        'generate_image',
        // v1.6: the member's cloud computer — run, move files, stop (recorded writes).
        // v1.7: a rendered report is a new file in the member's Files — recorded, additive.
      ].sort(),
    );
  });

  it('MCP_EXPOSED_TOOL_IDS matches the pinned MCP surface', () => {
    expect(core(MCP_EXPOSED_TOOL_IDS)).toEqual(
      [
        'session_query',
        // 2026-07-23: image generation opened to MCP so image-producing skills
        // call a tool instead of a REST relay.
        'generate_image',
        // 2026-08-16: automation_query stays (reading your own schedule is
        // harmless and useful); automation_mutation left — a machine client IS
        // unattended, and an automation that can create automations multiplies.
        'automation_query',
        // 2026-08-16: the email pair left MCP entirely. email_mutation's safety
        // rests on a human reading the draft card, which no MCP caller has —
        // `user_confirmed` and the synthetic `confirm` are both self-asserted,
        // collapsing two-step confirmation into one. email_query left with it:
        // a private inbox is not something to hand a third-party client.
        // Both keep their proxy tier (CLI + Mission sandbox still use them).
        // v1.5: members' agents reach the team's files in their own `files`
        // group; writes are recorded and deletes take the preview round trip.
        'files_query',
        'files_mutation',
        // v1.5: Issues & requests in their own `feedback` group — file a request,
        // log a friction (recorded writes), read back your own requests (plain read).
        // v1.6: the paid services in their own `services` group: web search,
        // page reads, image analysis and generation (generate_image moved here
        // from the retired `image` group; old grants keep it, see registry).
        'web_search',
        'read_url',
        'analyze_image',
        // v1.6: the member's cloud computer in its own `computer` group (off
        // until an admin turns it on; not even listed while off).
        // v1.7: report templates and rendering in their own `reports` group.
        // v3: connectors in their own `connectors` group (existing grants do not gain it).
        'mcp_call',
      ].sort(),
    );
  });

  it('the connectors group holds mcp_call and nothing else', () => {
    expect(sorted(new Set(MCP_TOOL_IDS_BY_GROUP.get('connectors') ?? []))).toEqual(['mcp_call']);
  });

  it('every MCP-exposed tool declares a resource group, and groups only contain exposed tools', () => {
    // A tool that reached MCP without a group would be unreachable for every
    // grant (groups are what a user consents to) — fail-closed, but silently.
    const grouped = new Set<string>();
    for (const [group, ids] of MCP_TOOL_IDS_BY_GROUP) {
      expect(allMcpResourceGroups(), `unknown resource group ${group}`).toContain(group);
      for (const id of ids) {
        expect(MCP_EXPOSED_TOOL_IDS.has(id), `${id} is in group ${group} but not MCP-exposed`).toBe(true);
        grouped.add(id);
      }
    }
    expect(sorted(grouped)).toEqual(sorted(MCP_EXPOSED_TOOL_IDS));
  });

  it('every resource group is reachable with read-only scope', () => {
    // resolveProxyToolIds narrows reads by group and writes by group ∩ mcp:write.
    // A group holding only write tools would resolve to an empty read set, and
    // an empty `allowedTools` used to mean "no narrowing at all".
    for (const [group, ids] of MCP_TOOL_IDS_BY_GROUP) {
      const readable = [...ids].filter((id) => READONLY_PROXY_ALLOWLIST.has(id));
      expect(readable.length, `group ${group} has no readable tool`).toBeGreaterThan(0);
    }
  });

  it('every MCP-exposed tool also carries a proxy tier (reachability invariant)', () => {
    for (const id of MCP_EXPOSED_TOOL_IDS) {
      expect(
        READONLY_PROXY_ALLOWLIST.has(id) || MUTATING_PROXY_ALLOWLIST.has(id),
        `${id} is mcp:true but has no proxy tier — it would be listed but never reachable`,
      ).toBe(true);
    }
  });

  it('proxy tiers are disjoint (a tool is read XOR write)', () => {
    for (const id of READONLY_PROXY_ALLOWLIST) {
      expect(MUTATING_PROXY_ALLOWLIST.has(id), `${id} is in both proxy tiers`).toBe(false);
    }
  });

  it('LAZY_TOOL_IDS matches the pinned per-request set', () => {
    expect(core(LAZY_TOOL_IDS)).toEqual(
      [
        'analyze_image',
        'generate_image',
        'session_query',
        'call_llm',
        'task_capture',
        'read_attachment',
        'export_data',
        'automation_query',
        'automation_mutation',
        'files_query',
        'files_mutation',
        'web_search',
        'read_url',
        'mcp_call',
      ].sort(),
    );
  });

  it('tables_schema_plan is chat-only — never proxied or MCP-exposed', () => {
    // Schema editing is gated on a human pressing Confirm on the plan card.
    // The proxy and MCP have no such human, only a self-declared confirm flag,
    // so exposing it there would hand an integration the power to restructure
    // tables unattended (spec D3).
    expect(READONLY_PROXY_ALLOWLIST.has('tables_schema_plan')).toBe(false);
    expect(MUTATING_PROXY_ALLOWLIST.has('tables_schema_plan')).toBe(false);
    expect(MCP_EXPOSED_TOOL_IDS.has('tables_schema_plan')).toBe(false);
  });

  it('default-deny: tools without surface are on neither proxy tier', () => {
    for (const meta of TOOL_DEFINITIONS) {
      if (!meta.surface) {
        expect(READONLY_PROXY_ALLOWLIST.has(meta.id)).toBe(false);
        expect(MUTATING_PROXY_ALLOWLIST.has(meta.id)).toBe(false);
        expect(MCP_EXPOSED_TOOL_IDS.has(meta.id)).toBe(false);
      }
    }
  });
});
