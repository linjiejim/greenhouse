import { describe, expect, it } from 'vitest';
import { EMPTY_DRAFT, canSaveDraft, createBody, draftOf, taskPatch, validDay } from './task-draft';

describe('task drafts', () => {
  it('starts from a saved task', () => {
    expect(draftOf({ title: 'Ship', assignee_id: 'usr_a', due_date: '2026-10-30T00:00:00.000Z', priority: 'high' })).toEqual({
      title: 'Ship',
      assigneeId: 'usr_a',
      due: '2026-10-30',
      priority: 'high',
    });
    expect(draftOf({ title: 'x', assignee_id: null, due_date: null, priority: 'weird' as never }).priority).toBe('normal');
  });

  it('needs a title', () => {
    expect(canSaveDraft(EMPTY_DRAFT)).toBe(false);
    expect(canSaveDraft({ ...EMPTY_DRAFT, title: '   ' })).toBe(false);
    expect(canSaveDraft({ ...EMPTY_DRAFT, title: 'Write' })).toBe(true);
  });

  it('needs a real due day when one is typed', () => {
    expect(validDay('2026-11-01')).toBe(true);
    expect(validDay('2026-02-30')).toBe(false);
    expect(validDay('2026-1-1')).toBe(false);
    expect(canSaveDraft({ ...EMPTY_DRAFT, title: 'Write', due: '2026-13-01' })).toBe(false);
  });

  it('posts only what is set', () => {
    expect(createBody({ ...EMPTY_DRAFT, title: '  Write the brief ' })).toEqual({ title: 'Write the brief', priority: 'normal' });
    expect(createBody({ title: 'A', assigneeId: 'usr_b', due: '2026-11-01', priority: 'urgent' })).toEqual({
      title: 'A',
      assignee_id: 'usr_b',
      due_date: '2026-11-01',
      priority: 'urgent',
    });
  });

  it('patches only what changed, null clearing', () => {
    const from = { title: 'A', assigneeId: 'usr_b', due: '2026-11-01', priority: 'normal' as const };
    expect(taskPatch(from, from)).toEqual({});
    expect(taskPatch(from, { ...from, title: ' A ' })).toEqual({});
    expect(taskPatch(from, { ...from, title: '' })).toEqual({});
    expect(taskPatch(from, { title: 'B', assigneeId: null, due: null, priority: 'high' })).toEqual({
      title: 'B',
      assignee_id: null,
      due_date: null,
      priority: 'high',
    });
  });
});
