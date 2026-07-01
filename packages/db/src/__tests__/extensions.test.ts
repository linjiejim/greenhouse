/**
 * GUARD TEST — the DB fork extension point (extensions.ts).
 *
 * The open-source release must ship ZERO private services/tables: both the
 * extension services and the extra reset tables must be empty upstream. A fork
 * populates them; this pins the empty upstream invariant (no live DB needed —
 * createExtensionServices ignores its arg upstream).
 */

import { describe, it, expect } from 'vitest';
import { createExtensionServices, EXTENSION_RESET_TABLES } from '../extensions.js';
import type { Db } from '../client.js';

describe('db extension seam', () => {
  it('ships no fork services or reset tables upstream (OSS invariant)', () => {
    expect(EXTENSION_RESET_TABLES).toEqual([]);
    expect(createExtensionServices({} as Db)).toEqual({});
  });
});
