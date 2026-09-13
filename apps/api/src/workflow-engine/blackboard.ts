/**
 * Blackboard — how node inputs read upstream outputs (ADK-style shared state).
 *
 * Nodes never talk to each other; they read named inputs resolved here from
 * the run's task statement and prior nodes' structured outputs. A skipped
 * upstream resolves to null (dependents must tolerate missing data).
 */

export interface BlackboardContext {
  taskInput: string;
  /** nodeId → parsed outputs (null for skipped nodes). */
  outputs: Map<string, unknown>;
}

/**
 * The one definition of what a node id may look like, and the one reference
 * pattern built from it. Both the graph schema and the graph's reference
 * validator import these rather than restating them.
 *
 * They were three separate copies of the same charset until 2026-08-07, and the
 * cost of them disagreeing is silent: an id the schema accepts but the
 * reference pattern rejects makes `$nodes.<id>.outputs...` fall through as a
 * literal, so the node receives the reference STRING instead of its upstream
 * data — no error anywhere. Extend the charset here or nowhere.
 *
 * Underscores are legal because models reach for snake_case by default and
 * rejecting it bought nothing: an id is an opaque key, not a URL slug. The dot
 * is the only character with meaning in a reference.
 */
const NODE_ID_CHARS = '[a-z0-9][a-z0-9_-]*';

export const NODE_ID_PATTERN = new RegExp(`^${NODE_ID_CHARS}$`);

/** `$nodes.<id>.outputs[.<dot.path>]` — capture 1 = node id, capture 2 = path. */
export const INPUT_REF_PATTERN = new RegExp(`^\\$nodes\\.(${NODE_ID_CHARS})\\.outputs(?:\\.(.+))?$`);

const INPUT_REF = INPUT_REF_PATTERN;

export function resolveInputs(
  inputs: Record<string, string> | undefined,
  ctx: BlackboardContext,
): { resolved: Record<string, unknown>; errors: string[] } {
  const resolved: Record<string, unknown> = {};
  const errors: string[] = [];

  for (const [name, ref] of Object.entries(inputs ?? {})) {
    if (ref === '$run.input') {
      resolved[name] = ctx.taskInput;
      continue;
    }
    const m = ref.startsWith('$') ? INPUT_REF.exec(ref) : null;
    if (!m) {
      resolved[name] = ref; // literal
      continue;
    }
    const [, nodeId, path] = m;
    if (!ctx.outputs.has(nodeId!)) {
      errors.push(`input ${name}: no outputs for node ${nodeId}`);
      continue;
    }
    const base = ctx.outputs.get(nodeId!);
    if (base === null || base === undefined) {
      resolved[name] = null; // skipped upstream
      continue;
    }
    if (!path) {
      resolved[name] = base;
      continue;
    }
    const value = digPath(base, path);
    if (value === undefined) {
      errors.push(`input ${name}: path ${path} not found in outputs of ${nodeId}`);
      continue;
    }
    resolved[name] = value;
  }

  return { resolved, errors };
}

function digPath(base: unknown, dotPath: string): unknown {
  let cur: unknown = base;
  for (const key of dotPath.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}
