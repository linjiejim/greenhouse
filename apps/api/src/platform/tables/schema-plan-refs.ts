/**
 * Plan references inside config JSON (spec §9, D18).
 *
 * A config may point at an object the same plan creates with the string token
 * `"$<kind>:<ref>"` — as a value (`"groupFieldId": "$field:status"`) or as an
 * object key (`"widths": {"$field:status": 160}`), at any depth. Automation
 * templates may also embed `{{field:$field:<ref>}}` inside text. At apply time
 * every token becomes the real id (a number as a value, its decimal string as a
 * key); at draft time the same rewrite uses placeholder ids, so the real
 * validators can run over the plan.
 *
 * Pure: no database, no dispatch.
 */

import { SCHEMA_PLAN_REF_KINDS, type SchemaPlanRef, type SchemaPlanRefKind } from '@greenhouse/types/tables';

const KIND_PATTERN = SCHEMA_PLAN_REF_KINDS.join('|');
/** The whole string is one token. */
const TOKEN = new RegExp(`^\\$(${KIND_PATTERN}):([A-Za-z0-9_-]{1,64})$`);
/** A token inside an automation `{{field:…}}` template. */
const TEMPLATE_TOKEN = /\{\{\s*field\s*:\s*\$field:([A-Za-z0-9_-]{1,64})\s*\}\}/g;

export interface SchemaPlanRefUse {
  kind: SchemaPlanRefKind;
  ref: SchemaPlanRef;
}

export function parseRefToken(value: string): SchemaPlanRefUse | undefined {
  const match = TOKEN.exec(value);
  return match ? { kind: match[1] as SchemaPlanRefKind, ref: match[2]! } : undefined;
}

/** Every token used in `value` (keys, values and templates), in first-seen order. */
export function collectRefTokens(value: unknown): SchemaPlanRefUse[] {
  const found = new Map<string, SchemaPlanRefUse>();
  const note = (use: SchemaPlanRefUse | undefined) => {
    if (use) found.set(`${use.kind}:${use.ref}`, use);
  };
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      note(parseRefToken(node));
      for (const match of node.matchAll(TEMPLATE_TOKEN)) note({ kind: 'field', ref: match[1]! });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) {
        note(parseRefToken(key));
        walk(child);
      }
    }
  };
  walk(value);
  return [...found.values()];
}

/** The id a token stands for, or undefined when the ref has none (yet). */
export type RefLookup = (use: SchemaPlanRefUse) => number | undefined;

export class UnresolvedRefError extends Error {
  constructor(readonly use: SchemaPlanRefUse) {
    super(`$${use.kind}:${use.ref} has no id`);
    this.name = 'UnresolvedRefError';
  }
}

/**
 * A deep copy of `value` with every token replaced by its id. Throws
 * `UnresolvedRefError` for a token `lookup` cannot resolve — the caller turns
 * that into a skip (apply) or a problem (draft).
 */
export function resolveRefTokens<T>(value: T, lookup: RefLookup): T {
  const idOf = (use: SchemaPlanRefUse): number => {
    const id = lookup(use);
    if (id === undefined) throw new UnresolvedRefError(use);
    return id;
  };
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const use = parseRefToken(node);
      if (use) return idOf(use);
      return node.includes('$field:')
        ? node.replace(TEMPLATE_TOKEN, (_match, ref: string) => `{{field:${idOf({ kind: 'field', ref })}}}`)
        : node;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(node)) {
        const use = parseRefToken(key);
        out[use ? String(idOf(use)) : key] = walk(child);
      }
      return out;
    }
    return node;
  };
  return walk(value) as T;
}
