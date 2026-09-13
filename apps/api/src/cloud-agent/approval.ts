/** Cloud Agent mutation approval policy and exact-input binding. */

import { createHash } from 'node:crypto';

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
}

export function canonicalAgentToolInput(input: unknown): string {
  return JSON.stringify(canonicalize(input ?? {}));
}

export function hashAgentToolInput(input: unknown): string {
  return createHash('sha256').update(canonicalAgentToolInput(input)).digest('hex');
}

export function agentToolAction(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const action = (input as Record<string, unknown>).action;
  return typeof action === 'string' ? action : null;
}

/**
 * The only current auto-approved platform mutation is saving an email draft:
 * it remains private, does not contact a third party, and is trivially
 * reversible. Every other mutation is fail-closed until explicitly reviewed.
 */
export function cloudMutationNeedsApproval(toolId: string, input: unknown): boolean {
  return !(toolId === 'email_mutation' && agentToolAction(input) === 'draft');
}
