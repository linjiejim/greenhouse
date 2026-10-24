import { describe, expect, it } from 'vitest';
import { fileSection, stationSections, taskSection } from './search';
import type { MyTask } from './tasks';

describe('search results', () => {
  it('turns the station’s groups into objects to open', () => {
    const sections = stationSections([
      { kind: 'session', hasMore: false, items: [{ title: '周报', sessionId: 's1' }] },
      { kind: 'kb_doc', hasMore: false, items: [{ title: 'Doc', ref: { kind: 'kb_doc', id: 4, slug: 'doc' } }] },
      { kind: 'project', hasMore: false, items: [{ title: 'P', ref: { kind: 'project', id: '7' } }] },
      { kind: 'crm_lead', hasMore: false, items: [{ title: 'Lead', ref: { kind: 'crm_lead', id: 1 } }] },
    ]);
    expect(sections.map((s) => s.kind)).toEqual(['session', 'kb_doc', 'project']);
    expect(sections[0]!.hits[0]!.ref).toEqual({ kind: 'chat', sessionId: 's1' });
    expect(sections[2]!.hits[0]!.ref).toEqual({ kind: 'project', id: 7 });
  });

  it('finds files and my tasks', () => {
    expect(fileSection([{ id: 3, name: 'a.pdf', size: 10 }], () => '10 B')?.hits[0]).toMatchObject({ ref: { kind: 'file', id: 3, name: 'a.pdf' }, subtitle: '10 B' });
    expect(fileSection([], () => '')).toBeNull();
    const tasks = [{ id: 1, project_id: 2, title: 'Ship Q4 report', project_title: 'Ops' }, { id: 2, project_id: 2, title: 'Other', project_title: 'Ops' }] as MyTask[];
    expect(taskSection(tasks, 'q4')?.hits.map((h) => h.ref)).toEqual([{ kind: 'task', projectId: 2, id: 1 }]);
    expect(taskSection(tasks, ' ')).toBeNull();
  });
});
