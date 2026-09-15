import { describe, expect, it } from 'vitest';
import { shouldReconcileSelectionWatcher } from './watcher-reconciliation';

describe('shouldReconcileSelectionWatcher', () => {
  it('restarts a configured watcher that stopped while permission was missing', () => {
    expect(
      shouldReconcileSelectionWatcher(
        { selectionWatch: true },
        { selection: { state: 'available' }, selectionWatch: false },
        false,
      ),
    ).toBe(true);
  });

  it('starts a pending enable after the user grants permission', () => {
    expect(
      shouldReconcileSelectionWatcher(
        { selectionWatch: false },
        { selection: { state: 'available' }, selectionWatch: false },
        true,
      ),
    ).toBe(true);
  });

  it('does not loop while permission is missing or the watcher is already running', () => {
    expect(
      shouldReconcileSelectionWatcher(
        { selectionWatch: true },
        { selection: { state: 'needs_permission', permission: 'accessibility' }, selectionWatch: false },
        false,
      ),
    ).toBe(false);
    expect(
      shouldReconcileSelectionWatcher(
        { selectionWatch: true },
        { selection: { state: 'available' }, selectionWatch: true },
        false,
      ),
    ).toBe(false);
  });
});
