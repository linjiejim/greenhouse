/**
 * Random identifier helpers.
 */

import { randomUUID } from 'node:crypto';

/**
 * A random, opaque document id like `doc-1a2b3c4d`.
 *
 * Doc ids are system-assigned and never derived from the title — the
 * human-facing identifier is always the title (shown in the list, header and
 * nav). Keeping the id random means behaviour is identical for every language
 * (no Chinese/slug special-casing) and there are no slug rules to maintain. The
 * 8-hex suffix matches the codebase's short-id convention (see media / uploads);
 * doc creation still guards against the astronomically unlikely duplicate.
 */
export function randomDocId(prefix = 'doc'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}
