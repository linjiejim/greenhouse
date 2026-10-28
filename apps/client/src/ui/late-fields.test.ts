import { describe, expect, it } from 'vitest';
import { createLateFields } from './late-fields';

describe('late fields', () => {
  it('reads every registered field at the time of the call', () => {
    const fields = createLateFields();
    let title = 'Ship Q';
    fields.register('title', () => title);
    fields.register('due', () => null);
    title = 'Ship Q3';
    expect(fields.read()).toEqual({ title: 'Ship Q3' });
  });

  it('forgets a field once it unregisters, but not a newer reader under the same key', () => {
    const fields = createLateFields();
    const dropOld = fields.register('title', () => 'old');
    fields.register('title', () => 'new');
    dropOld();
    expect(fields.read()).toEqual({ title: 'new' });
  });
});
