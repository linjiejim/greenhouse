/**
 * Tests for tool registry — verifies local tools are registered correctly.
 */

import { describe, it, expect } from 'vitest';
import { getToolMeta, getToolDescription, getToolsByCategory, getAllToolIds } from '../registry.js';

describe('Tool Registry — Local Tools', () => {
  const localToolIds = [
    'local_file_read',
    'local_file_write',
    'local_file_search',
    'local_shell',
    'local_clipboard',
    'local_compute',
    'local_skill_list',
    'local_skill_view',
  ];

  it('all local tools are registered', () => {
    for (const id of localToolIds) {
      const meta = getToolMeta(id);
      expect(meta, `Tool "${id}" should be registered`).toBeDefined();
    }
  });

  it('local tools have category "local"', () => {
    for (const id of localToolIds) {
      const meta = getToolMeta(id)!;
      expect(meta.category).toBe('local');
    }
  });

  it('local tools are not global', () => {
    for (const id of localToolIds) {
      const meta = getToolMeta(id)!;
      expect(meta.is_global).toBe(false);
    }
  });

  it('getToolDescription works for local tools', () => {
    expect(getToolDescription('local_file_read')).toContain('Read');
    expect(getToolDescription('local_shell')).toContain('shell');
    expect(getToolDescription('local_compute')).toContain('Execute code');
    expect(getToolDescription('local_skill_list')).toContain('List local Agent Skills');
    expect(getToolDescription('local_skill_view')).toContain('Read a local SKILL.md');
  });

  it('getToolsByCategory("local") returns all local tools', () => {
    const localTools = getToolsByCategory('local');
    expect(localTools.length).toBe(8);
    const ids = localTools.map((t) => t.id);
    for (const id of localToolIds) {
      expect(ids).toContain(id);
    }
  });

  it('local tools have sort_order >= 40', () => {
    const localTools = getToolsByCategory('local');
    for (const tool of localTools) {
      expect(tool.sort_order).toBeGreaterThanOrEqual(40);
    }
  });

  it('getAllToolIds includes local tools', () => {
    const allIds = getAllToolIds();
    for (const id of localToolIds) {
      expect(allIds).toContain(id);
    }
  });
});
