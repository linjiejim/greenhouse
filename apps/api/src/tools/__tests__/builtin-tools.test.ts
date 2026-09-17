/**
 * The built-in tool set, and the invariant that keeps it safe.
 *
 * Built-ins exist because a custom Agent's `tools` array is an intersection
 * filter: anything the author did not think of is absent, and an Agent that
 * cannot ask a clarifying question or schedule what it was asked to schedule
 * reads as broken rather than as narrow (dev, 2026-08-13 — an email Agent asked
 * for a daily 8am check could only answer that it had no way to).
 *
 * The set is pinned here for the same reason the proxy surfaces are: it widens
 * what an Agent may reach, so it must never grow by accident.
 */

import { describe, it, expect } from 'vitest';
import { BUILTIN_AGENT_TOOL_IDS, MUTATING_PROXY_ALLOWLIST, TOOL_DEFINITIONS } from '../registry.js';
import { UNATTENDED_TOOL_DENYLIST } from '../../agent-runtime/tool-resolution.js';

const EXPECTED = [
  'agent_chat',
  'analyze_image',
  'ask_user',
  'automation_mutation',
  'automation_query',
  'compute',
  'export_data',
  'log_friction',
  'memory',
  'read_attachment',
  'task_capture',
].sort();

describe('BUILTIN_AGENT_TOOL_IDS', () => {
  it('is exactly the reviewed set', () => {
    expect([...BUILTIN_AGENT_TOOL_IDS].sort()).toEqual(EXPECTED);
  });

  it('holds no domain data, outbound channel or unbounded dispatch tool', () => {
    // "What may this Agent see and do" is the author's design decision. CRM,
    // knowledge, Tables, email and mission/workflow dispatch stay opt-in.
    // agent_chat is the bounded, read-only peer discussion exception: targets
    // are requester-authorized and cannot recursively dispatch work.
    const forbidden = [
      'knowledge_query',
      'knowledge_mutation',
      'tables_query',
      'email_query',
      'email_mutation',
      'generate_image',
      'external_search',
      'spawn_session',
      'mission_dispatch',
      'workflow_plan',
    ];
    for (const id of forbidden) expect(BUILTIN_AGENT_TOOL_IDS.has(id)).toBe(false);
  });

  it('contains exactly one write tool, and that one cannot self-propagate', () => {
    // `automation_mutation` is the single exception: owner-scoped, quota-capped,
    // and already denied in unattended contexts — so a scheduled run cannot use
    // it to create more scheduled runs.
    const writes = [...BUILTIN_AGENT_TOOL_IDS].filter((id) => MUTATING_PROXY_ALLOWLIST.has(id));
    expect(writes).toEqual(['automation_mutation']);
    expect(UNATTENDED_TOOL_DENYLIST.has('automation_mutation')).toBe(true);
  });

  it('marks the flag on the tool definitions themselves, not in a parallel list', () => {
    const marked = TOOL_DEFINITIONS.filter((m) => m.builtin === true).map((m) => m.id);
    expect(marked.sort()).toEqual(EXPECTED);
  });
});
