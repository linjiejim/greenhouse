/**
 * Client Action Tools — agent tools that operate the user's current frontend screen.
 *
 * These reuse the SAME client-side execution round-trip as Desktop local tools:
 * the tool's execute() emits a `local-tool-request` via the {@link LocalToolBridge}
 * and awaits the real result the client posts back to /api/client-tools/result.
 *
 * Unlike local tools (a fixed server-side catalog of OS capabilities), client actions
 * are DECLARED BY THE CLIENT per request — each turn the frontend advertises which UI
 * actions are available on the current screen (navigate, prefill a form, read the
 * current view, ...). The backend stays generic: it just registers whatever the client
 * declared as bridge-backed tools. This mirrors AG-UI's "frontend tools are declared by
 * the client" model.
 *
 * Safety: client actions execute only in that same client's browser and never touch the
 * database directly (real writes still go through the confirmed server-side mutation
 * tools). So a client declaring an unexpected action can only affect its own UI.
 */

import { tool, jsonSchema } from 'ai';
import type { ClientActionDescriptor } from '@greenhouse/types/api';
import type { LocalToolBridge } from './local/bridge.js';

/** Hard caps so a misbehaving client can't flood the tool set. */
const MAX_ACTIONS = 32;
const MAX_NAME_LEN = 64;
const MAX_DESC_LEN = 2000;
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validate + clamp client-declared action descriptors.
 * Drops anything malformed rather than throwing — a bad action shouldn't 500 the chat.
 */
export function sanitizeClientActions(raw: unknown): ClientActionDescriptor[] {
  if (!Array.isArray(raw)) return [];
  const out: ClientActionDescriptor[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_ACTIONS) break;
    if (!item || typeof item !== 'object') continue;
    const { name, description, parameters } = item as Record<string, unknown>;
    if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > MAX_NAME_LEN) continue;
    if (seen.has(name)) continue;
    if (typeof description !== 'string' || !description.trim()) continue;
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) continue;
    seen.add(name);
    out.push({
      name,
      description: description.slice(0, MAX_DESC_LEN),
      parameters: parameters as Record<string, unknown>,
    });
  }
  return out;
}

/**
 * Build AI SDK tools from client-declared action descriptors, wired to the bridge.
 * Each tool's execute() round-trips to the client and returns the real UI result.
 */
export function createClientActionTools(
  descriptors: ClientActionDescriptor[],
  bridge: LocalToolBridge,
): Record<string, any> {
  const tools: Record<string, any> = {};
  for (const d of descriptors) {
    tools[d.name] = tool({
      description: d.description,
      inputSchema: jsonSchema<Record<string, unknown>>(d.parameters as Parameters<typeof jsonSchema>[0]),
      execute: async (input: Record<string, unknown>, { toolCallId }: { toolCallId: string }) =>
        bridge.requestExecution(d.name, input ?? {}, toolCallId),
    });
  }
  return tools;
}
