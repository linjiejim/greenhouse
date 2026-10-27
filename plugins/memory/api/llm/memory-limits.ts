/**
 * Memory write-side limits and validation. Keep evaluated limits static: tool
 * descriptions read them while the catalog is loading. Sensitive-pattern
 * matching and evidence redaction are shared security helpers from the kit.
 */

/** Characters of memory titles injected into a system prompt. */
export const MEMORY_INDEX_BUDGET_CHARS = 2000;

export const MEMORY_TITLE_MAX = 80;
export const MEMORY_CONTENT_MAX = 2000;

/** Memories unused for this long drop out of the injected index (still searchable). */
export const MEMORY_DORMANT_AFTER_DAYS = 90;

import { findSensitiveSpans } from '@greenhouse/api/extension-kit';
export { findSensitiveSpans, redactEvidence } from '@greenhouse/api/extension-kit';

/**
 * Where the contact refusal points people. A memory records a DECISION; a person's
 * contact details are a record, and records have a home with access control,
 * an owner and an audit trail — none of which a replayed prompt fragment has.
 * Core names no tool here: which record system a station has depends on its plugins.
 */
const CONTACT_ROUTING =
  ' Contact details belong in a record system with an owner and access control (a CRM or a contacts table, if the station has one), not here: keep the memory to the decision itself and refer to people by name.';

export interface MemoryTextValidation {
  ok: boolean;
  error?: string;
}

/**
 * Guard a memory before it is stored. Shared by the `memory` tool and
 * PATCH /api/auth/me/memories/:id so both reject exactly the same things.
 */
export function validateMemoryText(input: { title?: string; content?: string }): MemoryTextValidation {
  const { title, content } = input;

  if (title !== undefined) {
    const trimmed = title.trim();
    if (trimmed.length === 0) return { ok: false, error: 'title must not be empty' };
    if (trimmed.length > MEMORY_TITLE_MAX) {
      return { ok: false, error: `title must be ${MEMORY_TITLE_MAX} characters or fewer` };
    }
  }
  if (content !== undefined) {
    const trimmed = content.trim();
    if (trimmed.length === 0) return { ok: false, error: 'content must not be empty' };
    if (trimmed.length > MEMORY_CONTENT_MAX) {
      return { ok: false, error: `content must be ${MEMORY_CONTENT_MAX} characters or fewer` };
    }
  }

  for (const field of [title, content]) {
    if (!field) continue;
    const [hit] = findSensitiveSpans(field);
    if (hit) {
      // Naming the offending fragment is what lets the model fix it: it cannot
      // see which of 2000 characters tripped the check, so an unnamed refusal
      // gets retried verbatim.
      const excerpt = field.slice(hit.start, hit.end);
      const routing = hit.label === 'an email address' || hit.label === 'a phone number' ? CONTACT_ROUTING : '';
      return {
        ok: false,
        error:
          `refusing to store this memory: "${excerpt}" looks like ${hit.label}. Memories are replayed in every future conversation — never put credentials or personal contact details in one.` +
          routing,
      };
    }
  }

  return { ok: true };
}
