/**
 * Contract test — the knowledge write-back descriptor must survive the server's
 * sanitizeClientActions() gate (same limits as the browser actions), or the
 * agent silently loses the save_to_knowledge tool.
 */

import { describe, expect, it } from 'vitest';
import { KNOWLEDGE_ACTION_DESCRIPTOR, KNOWLEDGE_ACTION_NAME } from './knowledge-actions';

const NAME_RE = /^[a-z][a-z0-9_]*$/;

describe('KNOWLEDGE_ACTION_DESCRIPTOR', () => {
  it('has a server-valid name matching the dispatch constant', () => {
    expect(KNOWLEDGE_ACTION_DESCRIPTOR.name).toBe(KNOWLEDGE_ACTION_NAME);
    expect(KNOWLEDGE_ACTION_DESCRIPTOR.name).toMatch(NAME_RE);
    expect(KNOWLEDGE_ACTION_DESCRIPTOR.name.length).toBeLessThanOrEqual(64);
  });

  it('has a non-empty description within the server cap', () => {
    expect(KNOWLEDGE_ACTION_DESCRIPTOR.description.trim().length).toBeGreaterThan(0);
    expect(KNOWLEDGE_ACTION_DESCRIPTOR.description.length).toBeLessThanOrEqual(2000);
  });

  it('declares a JSON-schema object with content required and declared params', () => {
    const p = KNOWLEDGE_ACTION_DESCRIPTOR.parameters;
    expect(p.type).toBe('object');
    expect(Array.isArray(p)).toBe(false);
    const props = p.properties as Record<string, unknown>;
    for (const key of (p.required as string[]) ?? []) {
      expect(props, `requires undeclared param "${key}"`).toHaveProperty(key);
    }
    expect(props).toHaveProperty('mode');
    expect(props).toHaveProperty('content');
    expect((p.required as string[]).includes('content')).toBe(true);
  });
});
