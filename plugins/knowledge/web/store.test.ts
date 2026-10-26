import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KNOWLEDGE_REMOTE_COALESCE_MS, useKnowledgeStore } from './store';

describe('knowledge store remote changes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useKnowledgeStore.setState({ version: 0 });
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('turns a burst of knowledge.changed events into one refetch', () => {
    const { remoteChanged } = useKnowledgeStore.getState();
    remoteChanged();
    remoteChanged();
    remoteChanged();
    expect(useKnowledgeStore.getState().version).toBe(0);
    vi.advanceTimersByTime(KNOWLEDGE_REMOTE_COALESCE_MS);
    expect(useKnowledgeStore.getState().version).toBe(1);

    // A later change is its own refetch.
    remoteChanged();
    vi.advanceTimersByTime(KNOWLEDGE_REMOTE_COALESCE_MS);
    expect(useKnowledgeStore.getState().version).toBe(2);
  });

  it('keeps local bumps immediate', () => {
    useKnowledgeStore.getState().bump();
    expect(useKnowledgeStore.getState().version).toBe(1);
  });
});
