/**
 * Risk tier of one external-agent write.
 *
 * The tool catalog gives every proxy write tool a base risk (r2 unless the tool
 * declares `runtime_risk`); this module refines it per call from the action
 * the agent asked for:
 *   r1  own and reversible  → runs at once
 *   r2  shared data          → runs with a standing grant, else waits for approval
 *   r3  irreversible         → always waits for approval; grants never cover it
 *
 * The rules are deliberately few and readable. A delete-like action is r3 for
 * every tool, extension tools included, so a new tool is safe by default; the
 * one r1 case is creating a document in the member's own personal knowledge.
 */

import type { RuntimeActionRisk } from '@greenhouse/types/runtime';

export interface WriteClassification {
  risk: Extract<RuntimeActionRisk, 'r1' | 'r2' | 'r3'>;
  /** The `action` argument when the tool has one (`records.update`, `knowledge.create_doc`…). */
  action: string | null;
  /**
   * What the write targets (tool + action + record identifiers), when it names
   * one. A newer pending request for the same target supersedes the older one.
   * Creates have no target.
   */
  targetKey: string | null;
}

const DESTRUCTIVE_VERB = /^(delete|remove|purge|destroy|drop)(_|$)/;

/** Identifier-like fields, in the order they best name a target. */
const TARGET_FIELDS = [
  'doc_id',
  'record_id',
  'record_ids',
  'task_id',
  'project_id',
  'company_id',
  'id',
  'name',
  'table_id',
  'base_id',
] as const;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function verbOf(action: string): string {
  const dot = action.lastIndexOf('.');
  return dot >= 0 ? action.slice(dot + 1) : action;
}

function targetOf(toolId: string, action: string | null, input: Record<string, unknown>): string | null {
  const parts: string[] = [];
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) parts.push(`${field}=${value}`);
    else if (typeof value === 'number') parts.push(`${field}=${value}`);
    else if (Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string')) {
      parts.push(`${field}=${[...(value as string[])].sort().join(',')}`);
    }
  }
  return parts.length > 0 ? [toolId, action ?? '-', ...parts].join('|') : null;
}

/**
 * @param baseRisk the catalog risk of the tool (`runtime_risk`, else r2 for a
 *   proxy write). r3 tools stay r3 whatever the action.
 */
export function classifyWrite(toolId: string, input: unknown, baseRisk: RuntimeActionRisk = 'r2'): WriteClassification {
  const args = asRecord(input);
  const action = typeof args.action === 'string' && args.action.length > 0 ? args.action : null;
  const targetKey = targetOf(toolId, action, args);

  if (baseRisk === 'r3') return { risk: 'r3', action, targetKey };
  if (action && DESTRUCTIVE_VERB.test(verbOf(action))) return { risk: 'r3', action, targetKey };
  if (toolId === 'knowledge_mutation' && action === 'knowledge.create_doc' && args.scope === 'personal') {
    return { risk: 'r1', action, targetKey };
  }
  return { risk: 'r2', action, targetKey };
}
