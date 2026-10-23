import { describe, expect, it } from 'vitest';
import { classifyWrite, writeToolCanDelete } from './risk.js';

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

  it('knows which write tools can delete, from the catalog risk or the action enum', () => {
    const schema = (actions: string[]) => ({
      type: 'object',
      properties: { action: { type: 'string', enum: actions } },
    });
    expect(writeToolCanDelete(schema(['records.create', 'records.delete']))).toBe(true);
    expect(writeToolCanDelete(schema(['skills.publish', 'skills.delete']))).toBe(true);
    expect(writeToolCanDelete(schema(['knowledge.create_doc', 'knowledge.archive_doc']))).toBe(false);
    expect(writeToolCanDelete({ type: 'object', properties: {} }, 'r3')).toBe(true);
    expect(writeToolCanDelete(undefined)).toBe(false);
  });
});
