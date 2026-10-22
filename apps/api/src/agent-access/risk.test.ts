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

  it('never gives creates or batches inside one container the same target', () => {
    // Two different new records in one table must not supersede each other.
    expect(
      classifyWrite('tables_mutation', { action: 'records.create', table_id: 't', values: { a: 1 } }).targetKey,
    ).toBeNull();
    expect(
      classifyWrite('tables_mutation', { action: 'records.batch_upsert', table_id: 't', items: [] }).targetKey,
    ).toBeNull();
    expect(
      classifyWrite('project_mutation', { action: 'task.create', project_id: 'p', title: 'x' }).targetKey,
    ).toBeNull();
    // A container alone is not a target; a record inside it is, and the container scopes it.
    expect(classifyWrite('tables_mutation', { action: 'table.rename', table_id: 't' }).targetKey).toBeNull();
    expect(
      classifyWrite('tables_mutation', { action: 'records.update', table_id: 't', record_id: 'r' }).targetKey,
    ).toBe('tables_mutation|records.update|table_id=t|record_id=r');
  });
});
