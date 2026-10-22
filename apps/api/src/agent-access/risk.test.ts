import { describe, expect, it } from 'vitest';
import { classifyWrite } from './risk.js';

describe('classifyWrite', () => {
  it('treats delete-like actions as r3 for every tool, extension tools included', () => {
    expect(classifyWrite('tables_mutation', { action: 'records.delete', record_id: 'r' }).risk).toBe('r3');
    expect(classifyWrite('skill_mutation', { action: 'skills.delete', name: 's' }).risk).toBe('r3');
    expect(classifyWrite('crm_mutation', { action: 'company.remove', id: 'c' }).risk).toBe('r3');
    expect(classifyWrite('crm_mutation', { action: 'purge_notes' }).risk).toBe('r3');
  });

  it('keeps reversible shared writes at r2', () => {
    expect(classifyWrite('knowledge_mutation', { action: 'knowledge.archive_doc', doc_id: 'd' }).risk).toBe('r2');
    expect(classifyWrite('project_mutation', { action: 'task.update', task_id: 't' }).risk).toBe('r2');
    expect(classifyWrite('knowledge_mutation', { action: 'knowledge.create_doc', scope: 'team' }).risk).toBe('r2');
    // "deleted_at" style words are not a delete verb.
    expect(classifyWrite('tables_mutation', { action: 'records.update', record_id: 'r' }).risk).toBe('r2');
  });

  it('lets a member create their own personal doc at once (r1)', () => {
    expect(classifyWrite('knowledge_mutation', { action: 'knowledge.create_doc', scope: 'personal' }).risk).toBe('r1');
    expect(
      classifyWrite('knowledge_mutation', { action: 'knowledge.update_doc', scope: 'personal', doc_id: 'd' }).risk,
    ).toBe('r2');
  });

  it('never lowers a tool the catalog marks r3', () => {
    expect(classifyWrite('anything', { action: 'records.create' }, 'r3').risk).toBe('r3');
  });

  it('derives a stable target key from record identifiers, none for creates', () => {
    const a = classifyWrite('tables_mutation', { action: 'records.update', record_ids: ['b', 'a'] });
    const b = classifyWrite('tables_mutation', { action: 'records.update', record_ids: ['a', 'b'], values: { x: 1 } });
    expect(a.targetKey).toBe(b.targetKey);
    expect(classifyWrite('project_mutation', { action: 'project.create', title: 'x' }).targetKey).toBeNull();
  });
});
