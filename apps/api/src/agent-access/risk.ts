/**
 * Risk tier of one external-agent write.
 *
 * The tool catalog gives every proxy write tool a base risk (r2 unless the tool
 * declares `runtime_risk`); this module refines it per call from the action
 * the agent asked for:
 *   r1  own and reversible  (a doc in the member's personal knowledge)
 *   r2  shared data
 *   r3  delete-like
 *
 * Tiers do not gate anything a member's own permissions allow. They are
 * recorded on every write, and r3 alone asks the agent for a preview round
 * trip (call → preview → call again with confirm:true) so its user sees what
 * goes before it goes.
 *
 * A delete-like verb is r3 for every tool, extension tools included, so a new
 * tool is covered by default.
 */

import type { RuntimeActionRisk } from '@greenhouse/types/runtime';

export interface WriteClassification {
  risk: Extract<RuntimeActionRisk, 'r1' | 'r2' | 'r3'>;
  /** The `action` argument when the tool has one (`records.update`, `knowledge.create_doc`…). */
  action: string | null;
}

const DESTRUCTIVE_VERB = /^(delete|remove|purge|destroy|drop)(_|$)/;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function verbOf(action: string): string {
  const dot = action.lastIndexOf('.');
  return dot >= 0 ? action.slice(dot + 1) : action;
}

export function isDeleteLikeAction(action: string): boolean {
  return DESTRUCTIVE_VERB.test(verbOf(action));
}

/**
 * @param baseRisk the catalog risk of the tool (`runtime_risk`, else r2 for a
 *   proxy write). r3 tools stay r3 whatever the action.
 */
export function classifyWrite(toolId: string, input: unknown, baseRisk: RuntimeActionRisk = 'r2'): WriteClassification {
  const args = asRecord(input);
  const action = typeof args.action === 'string' && args.action.length > 0 ? args.action : null;

  if (baseRisk === 'r3') return { risk: 'r3', action };
  if (action && isDeleteLikeAction(action)) return { risk: 'r3', action };
  if (toolId === 'knowledge_mutation' && action === 'knowledge.create_doc' && args.scope === 'personal') {
    return { risk: 'r1', action };
  }
  return { risk: 'r2', action };
}

/**
 * Whether a write tool can delete at all: its catalog risk is r3, or its
 * `action` enum offers a delete-like verb. Drives the MCP `destructiveHint`
 * annotation and whether the tool advertises the `confirm` flag.
 */
export function writeToolCanDelete(inputSchema: unknown, baseRisk: RuntimeActionRisk = 'r2'): boolean {
  if (baseRisk === 'r3') return true;
  const properties = asRecord(asRecord(inputSchema).properties);
  const actions = asRecord(properties.action).enum;
  return Array.isArray(actions) && actions.some((value) => typeof value === 'string' && isDeleteLikeAction(value));
}
