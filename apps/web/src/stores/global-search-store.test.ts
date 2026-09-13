import { beforeEach, describe, expect, it } from 'vitest';
import { useGlobalSearchStore } from './global-search-store';

describe('global search store launch context', () => {
  beforeEach(() => {
    useGlobalSearchStore.setState({ isOpen: false, initialQuery: '', initialKind: null });
  });

  it('carries a Desktop knowledge query into the next palette open', () => {
    useGlobalSearchStore.getState().open({ query: 'hydroponics', kind: 'kb_doc' });
    expect(useGlobalSearchStore.getState()).toMatchObject({
      isOpen: true,
      initialQuery: 'hydroponics',
      initialKind: 'kb_doc',
    });
  });

  it('clears stale launch context for normal opens', () => {
    useGlobalSearchStore.getState().open({ query: 'old', kind: 'kb_doc' });
    useGlobalSearchStore.getState().close();
    useGlobalSearchStore.getState().open();
    expect(useGlobalSearchStore.getState()).toMatchObject({ isOpen: true, initialQuery: '', initialKind: null });
  });
});
