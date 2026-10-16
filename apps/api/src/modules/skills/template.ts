/**
 * Template skills: instructions with `{{key}}` placeholders, and the fields that fill them (the
 * same fields ask_user shows). Every field must appear in the body, or filling it would change
 * nothing. An optional field left empty keeps its placeholder, so the Agent sees what is missing
 * instead of a sentence that silently lost a part.
 */

import { SKILL_VARIABLE_VALUE_MAX, type SkillVariable } from '@greenhouse/contract';

const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]{0,39})\s*\}\}/g;

/** The placeholders of a body, in the order they first appear. */
export function placeholdersIn(body: string): string[] {
  const keys: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) if (!keys.includes(match[1]!)) keys.push(match[1]!);
  return keys;
}

/** What is wrong with a template's fields, or null: a key twice, a field its body never uses. */
export function variablesProblem(body: string, variables: readonly SkillVariable[]): string | null {
  const keys = new Set<string>();
  for (const field of variables) {
    if (keys.has(field.key)) return `The field "${field.key}" is there twice.`;
    keys.add(field.key);
  }
  const used = placeholdersIn(body);
  const unused = variables.find((field) => !used.includes(field.key));
  return unused ? `The field "${unused.key}" has no {{${unused.key}}} in the text.` : null;
}

export type ValuesCheck =
  | { ok: true; values: Record<string, string> }
  | { ok: false; message: string; fields: string[] };

/**
 * The values a member filled in, checked against the fields: required ones present, a choice one
 * of its options, nothing too long. Values for keys the template does not have are dropped.
 */
export function checkValues(variables: readonly SkillVariable[], given: Record<string, string>): ValuesCheck {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const field of variables) {
    const value = (given[field.key] ?? '').trim();
    if (!value) {
      if (field.required) missing.push(field.key);
      continue;
    }
    if (value.length > SKILL_VARIABLE_VALUE_MAX) {
      return { ok: false, message: `"${field.label}" is too long.`, fields: [field.key] };
    }
    if (field.type === 'choice' && !(field.options ?? []).includes(value)) {
      return { ok: false, message: `"${field.label}" must be one of its options.`, fields: [field.key] };
    }
    values[field.key] = value;
  }
  if (missing.length) {
    const labels = missing.map((key) => variables.find((field) => field.key === key)!.label);
    return { ok: false, message: `Fill in ${labels.map((label) => `"${label}"`).join(', ')}.`, fields: missing };
  }
  return { ok: true, values };
}

/** The body with the values in; a placeholder without a value stays as it is. */
export function fillTemplate(body: string, values: Record<string, string>): string {
  return body.replace(PLACEHOLDER, (whole, key: string) => values[key] ?? whole);
}
