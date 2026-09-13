/**
 * @vitest-environment happy-dom
 */

import { describe, expect, it, vi } from 'vitest';
import { notifyWorkbenchChanged, onWorkbenchChanged } from './sync';

describe('workbench browser invalidation', () => {
  it('notifies mounted previews and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = onWorkbenchChanged(listener);

    notifyWorkbenchChanged();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    notifyWorkbenchChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
