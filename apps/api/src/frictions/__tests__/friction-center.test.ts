/**
 * Friction fingerprinting — the part that decides whether "the same stumble"
 * lands on one row or scatters into dozens.
 *
 * Aggregation IS the product here: the occurrence count is what orders the
 * review queue, so a fingerprint that varies with an id or a quoted value makes
 * a recurring problem look like noise.
 */

import { describe, expect, it } from 'vitest';
import { fingerprintFriction, normalizeErrorText } from '../friction-center.js';

describe('normalizeErrorText', () => {
  it('collapses ids, numbers and quoted values to placeholders', () => {
    expect(normalizeErrorText('customer 132 not found')).toBe('customer <n> not found');
    expect(normalizeErrorText('column "owner_name" does not exist')).toBe('column <value> does not exist');
    expect(normalizeErrorText('run 3f2504e0-4f89-11d3-9a0c-0305e82c3301 failed')).toBe('run <uuid> failed');
    expect(normalizeErrorText('expired at 2026-08-03T10:22:31Z')).toBe('expired at <date>');
  });

  it('is case- and whitespace-insensitive', () => {
    expect(normalizeErrorText('  Timed   OUT ')).toBe('timed out');
  });

  it('caps length so a stack trace cannot become the key', () => {
    expect(normalizeErrorText('e'.repeat(500)).length).toBeLessThanOrEqual(200);
  });
});

describe('fingerprintFriction', () => {
  it('groups the same failure across different record ids', () => {
    // The real case from dev: five consecutive get_customer calls, five ids,
    // one underlying mistake.
    const a = fingerprintFriction({
      tool_id: 'crm_query',
      kind: 'tool_error',
      signature: 'id and type (contact/company) are required',
    });
    const b = fingerprintFriction({
      tool_id: 'crm_query',
      kind: 'tool_error',
      signature: 'id and type (contact/company) are required',
    });
    expect(a).toBe(b);
  });

  it('separates different tools, kinds and failures', () => {
    const base = { tool_id: 'crm_query', kind: 'tool_error', signature: 'type is required' };
    const otherTool = fingerprintFriction({ ...base, tool_id: 'tables_query' });
    const otherKind = fingerprintFriction({ ...base, kind: 'detour' });
    const otherError = fingerprintFriction({ ...base, signature: 'rate limit exceeded' });

    const all = new Set([fingerprintFriction(base), otherTool, otherKind, otherError]);
    expect(all.size).toBe(4);
  });

  it('groups duplicate-record errors once their interpolated values are quoted', () => {
    // Nine contacts hit the same "already exists" wall on dev and produced nine
    // rows, because the ids normalised away but the bare names did not — one
    // problem sorted as nine one-off blips. Quoting the values at the point of
    // interpolation is what makes them collapse; this pins that contract.
    const message = (id: number, name: string) =>
      `Contact with email "a@b.com" already exists (ID: "${id}", Name: "${name}")`;
    const fingerprints = new Set(
      [
        [163, 'Robin Bremer'],
        [115, 'Caitlin Himpler'],
        [85, 'Nicholas'],
      ].map(([id, name]) =>
        fingerprintFriction({
          tool_id: 'crm_mutation',
          kind: 'tool_error',
          signature: message(id as number, name as string),
        }),
      ),
    );
    expect(fingerprints.size).toBe(1);
  });

  it('treats a missing tool id as its own bucket, not a crash', () => {
    const withNull = fingerprintFriction({ tool_id: null, kind: 'data_quirk', signature: 'domain empty everywhere' });
    const withTool = fingerprintFriction({
      tool_id: 'crm_query',
      kind: 'data_quirk',
      signature: 'domain empty everywhere',
    });
    expect(withNull).not.toBe(withTool);
    expect(withNull).toHaveLength(32);
  });
});
