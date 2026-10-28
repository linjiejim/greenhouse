import { describe, expect, it } from 'vitest';
import { fileSection, stationSections, taskSection } from './search';
import type { MyTask } from './tasks';

describe('search results', () => {
  it('turns the station’s groups into objects to open', () => {
    const sections = stationSections([
      { kind: 'session', hasMore: false, items: [{ title: '周报', sessionId: 's1' }] },
      { kind: 'kb_doc', hasMore: false, items: [{ title: 'Doc', ref: { kind: 'kb_doc', id: 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', slug: 'doc' } }] },
      { kind: 'project', hasMore: false, items: [{ title: 'P', ref: { kind: 'project', id: '7' } }] },
      { kind: 'crm_lead', hasMore: false, items: [{ title: 'Lead', ref: { kind: 'crm_lead', id: 'crm_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' } }] },
    ]);
    expect(sections.map((s) => s.kind)).toEqual(['session', 'kb_doc', 'project']);
    expect(sections[0]!.hits[0]!.ref).toEqual({ kind: 'chat', sessionId: 's1' });
    expect(sections[1]!.hits[0]!.ref).toEqual({ kind: 'doc', id: 'doc_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' });
    expect(sections[2]!.hits[0]!.ref).toEqual({ kind: 'project', id: '7' });
  });

  it('opens automation hits as automations and formats a conversation’s time', () => {
    const sections = stationSections(
      [
        { kind: 'session', hasMore: false, items: [{ title: 'Daily digest', sessionId: 's2', updatedAt: '2026-10-26T01:00:00.000Z' } as never] },
        { kind: 'automation', hasMore: false, items: [{ title: 'Daily digest', subtitle: 'Summarize yesterday', automationId: 'atm_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', enabled: true } as never] },
      ],
      (iso) => `at ${iso.slice(0, 10)}`,
    );
    expect(sections.map((s) => s.kind)).toEqual(['session', 'automation']);
    expect(sections[0]!.hits[0]!.subtitle).toBe('at 2026-10-26');
    expect(sections[1]!.hits[0]).toMatchObject({ subtitle: 'Summarize yesterday', ref: { kind: 'automation', id: 'atm_01JB2Y8Z9QW3E4R5T6Y7V8H9P0' } });
  });

  it('keeps the subtitle without a formatter and drops a malformed automation id', () => {
    const sections = stationSections([
      { kind: 'session', hasMore: false, items: [{ title: 'Old', sessionId: 's3', subtitle: 'yesterday' }] },
      { kind: 'automation', hasMore: false, items: [{ title: 'Bad', automationId: '../x' }] },
    ]);
    expect(sections.map((s) => s.kind)).toEqual(['session']);
    expect(sections[0]!.hits[0]!.subtitle).toBe('yesterday');
  });

  it('finds files and my tasks', () => {
    expect(fileSection([{ id: 'fil_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', name: 'a.pdf', size: 10 }], () => '10 B')?.hits[0]).toMatchObject({ ref: { kind: 'file', id: 'fil_01JB2Y8Z9QW3E4R5T6Y7V8H9P0', name: 'a.pdf' }, subtitle: '10 B' });
    expect(fileSection([], () => '')).toBeNull();
    const tasks = [{ id: '1', project_id: '2', title: 'Ship Q4 report', project_title: 'Ops' }, { id: '2', project_id: '2', title: 'Other', project_title: 'Ops' }] as MyTask[];
    expect(taskSection(tasks, 'q4')?.hits.map((h) => h.ref)).toEqual([{ kind: 'task', projectId: '2', id: '1' }]);
    expect(taskSection(tasks, ' ')).toBeNull();
  });
});
