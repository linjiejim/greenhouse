/**
 * Tasks — reusable prompts, with or without parameters.
 *
 * A Task IS a prompt: the same row, the same slash menu, the same sharing
 * rules. What "task" adds is everything that makes a one-off prompt survive
 * being reused — named variables, the tools the flow actually needed, and a
 * link back to the conversation it was distilled from.
 *
 * A row with no variables and no tools behaves exactly as prompts always have,
 * which is why this is an evolution of `user_prompts` rather than a second
 * table (spec D1).
 */

/** A `{{key}}` placeholder in the task body. */
export interface TaskVariable {
  /** Placeholder name; matches `{{key}}` in the body. */
  key: string;
  /** Human label for the fill-in form. */
  label: string;
  required?: boolean;
  /** Shown as the input's placeholder — a concrete sample, not instructions. */
  example?: string;
  description?: string;
}

export const TASK_VARIABLE_LIMITS = {
  maxVariables: 10,
  maxKeyLength: 40,
  maxLabelLength: 80,
  maxExampleLength: 200,
} as const;

/**
 * Legal placeholder names. Deliberately narrow — the key is substituted into
 * a regex, and it has to survive being written by hand in the body.
 * Internal on purpose: callers validate whole variables via `isTaskVariable`.
 */
const TASK_VARIABLE_KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;

export function isTaskVariable(value: unknown): value is TaskVariable {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.key === 'string' &&
    TASK_VARIABLE_KEY_RE.test(v.key) &&
    typeof v.label === 'string' &&
    v.label.length > 0 &&
    v.label.length <= TASK_VARIABLE_LIMITS.maxLabelLength &&
    (v.required === undefined || typeof v.required === 'boolean') &&
    (v.example === undefined ||
      (typeof v.example === 'string' && v.example.length <= TASK_VARIABLE_LIMITS.maxExampleLength)) &&
    (v.description === undefined || typeof v.description === 'string')
  );
}

/** Parse the stored JSON column; anything malformed degrades to "no variables". */
export function parseTaskVariables(raw: string | null | undefined): TaskVariable[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isTaskVariable).slice(0, TASK_VARIABLE_LIMITS.maxVariables);
  } catch {
    return [];
  }
}

export function parseExpectedTools(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((tool): tool is string => typeof tool === 'string' && tool.length > 0).slice(0, 40);
  } catch {
    return [];
  }
}

/** Placeholders actually present in the body, in first-appearance order. */
export function placeholdersIn(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}/g)) {
    const key = match[1]!;
    if (!seen.includes(key)) seen.push(key);
  }
  return seen;
}

/**
 * Substitute filled values into the body.
 *
 * Unfilled placeholders are LEFT IN PLACE rather than blanked: an empty gap
 * silently changes what the task asks for, whereas a visible `{{region}}`
 * reaching the model is something the profile prompt tells it to ask about.
 */
export function applyTaskVariables(body: string, values: Record<string, string>): string {
  return body.replace(/\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}/g, (whole, key: string) => {
    const value = values[key];
    return value !== undefined && value.trim() !== '' ? value : whole;
  });
}

/** Required variables with nothing filled in — the form's validation gate. */
export function missingRequired(variables: TaskVariable[], values: Record<string, string>): TaskVariable[] {
  return variables.filter((variable) => variable.required && !values[variable.key]?.trim());
}
