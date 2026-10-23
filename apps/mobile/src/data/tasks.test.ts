import { describe, expect, it } from 'vitest';
import type { ProjectTask } from '../shared/greenhouse-types';
import { addDays, dueBucket, findTask, flattenTasks, localDay, myTasks, parseTags, withTaskPatched } from './tasks';

const task = (id: number, over: Partial<ProjectTask> = {}): ProjectTask => ({
  id,
  project_id: 1,
  parent_id: null,
  title: `Task ${id}`,
  description: null,
  status: 'todo',
  priority: 'normal',
  assignee_id: 'me',
  start_date: null,
  due_date: null,
  completed_at: null,
  sort_order: id,
  estimated_hours: null,
  created_by: 'me',
  created_at: '2026-10-01T00:00:00Z',
  updated_at: '2026-10-01T00:00:00Z',
  ...over,
});

describe('task trees', () => {
  const tree = [task(1, { children: [task(2, { parent_id: 1, children: [task(3, { parent_id: 2 })] })] }), task(4)];

  it('flattens parents before children, without the children arrays', () => {
    expect(flattenTasks(tree).map((t) => t.id)).toEqual([1, 2, 3, 4]);
    expect(flattenTasks(tree).every((t) => !('children' in t))).toBe(true);
  });

  it('finds and patches a nested task without touching the rest', () => {
    expect(findTask(tree, 3)?.title).toBe('Task 3');
    const patched = withTaskPatched(tree, 3, { status: 'done' });
    expect(findTask(patched, 3)?.status).toBe('done');
    expect(findTask(tree, 3)?.status).toBe('todo');
    expect(patched[1]).toBe(tree[1]);
  });

  it('reads tags in either form', () => {
    expect(parseTags('["a","b"]')).toEqual(['a', 'b']);
    expect(parseTags(['x', '', 3])).toEqual(['x']);
    expect(parseTags('nope')).toEqual([]);
    expect(parseTags(null)).toEqual([]);
  });
});

describe('due dates', () => {
  const today = '2026-10-24';

  it('counts calendar days across a month end', () => {
    expect(addDays('2026-10-30', 3)).toBe('2026-11-02');
    expect(localDay(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });

  it('buckets by day', () => {
    expect(dueBucket('2026-10-23', today)).toBe('overdue');
    expect(dueBucket('2026-10-24', today)).toBe('today');
    expect(dueBucket('2026-10-31', today)).toBe('soon');
    expect(dueBucket('2026-11-01', today)).toBe('later');
    expect(dueBucket(null, today)).toBe('none');
    expect(dueBucket('2026-10-24T10:00:00Z', today)).toBe('today');
  });
});

describe('my tasks', () => {
  it('keeps my open tasks, grouped by due, soonest first', () => {
    const projects = [
      {
        id: 1,
        title: 'Launch',
        color: null,
        tasks: [
          task(1, { due_date: '2026-10-30', children: [task(2, { due_date: '2026-10-20' })] }),
          task(3, { due_date: '2026-10-25', status: 'done' }),
          task(4, { assignee_id: 'sam', due_date: '2026-10-24' }),
        ],
      },
      { id: 2, title: 'Ops', color: '#f00', tasks: [task(5), task(6, { due_date: '2026-10-26', status: 'in_review' })] },
    ];
    const groups = myTasks(projects, 'me', '2026-10-24');
    expect(groups.map((g) => [g.bucket, g.tasks.map((t) => t.id)])).toEqual([
      ['overdue', [2]],
      ['soon', [6, 1]],
      ['none', [5]],
    ]);
    expect(groups[1]!.tasks[0]!.project_title).toBe('Ops');
  });
});
