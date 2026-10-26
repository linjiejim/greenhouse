import { afterEach, describe, expect, it } from 'vitest';
import { invalidateProjects, useProjectRefreshStore } from './project-refresh-store.js';

afterEach(() => {
  useProjectRefreshStore.setState({ revision: 0 });
});

describe('Project refresh store', () => {
  it('publishes a monotonic revision for project collection mutations', () => {
    expect(useProjectRefreshStore.getState().revision).toBe(0);

    invalidateProjects();
    invalidateProjects();

    expect(useProjectRefreshStore.getState().revision).toBe(2);
  });
});
