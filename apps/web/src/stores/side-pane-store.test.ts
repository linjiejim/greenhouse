/**
 * @vitest-environment happy-dom
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { maxSidePaneWidth, SIDE_PANE_MIN_WIDTH, useSidePaneStore } from './side-pane-store';

const company = { kind: 'project', id: 42 } as const;
const contact = { kind: 'kb_doc', id: 7, slug: 'contact-notes' } as const;

describe('side pane store', () => {
  beforeEach(() => {
    useSidePaneStore.setState({ stack: [], isOpen: false, isFullscreen: false, hostMounted: false });
  });

  it('stacks records so a drill-down can be undone', () => {
    const { open } = useSidePaneStore.getState();
    open({ kind: 'entity', ref: company });
    open({ kind: 'entity', ref: contact });

    expect(useSidePaneStore.getState().stack).toHaveLength(2);
    expect(useSidePaneStore.getState().isOpen).toBe(true);
    useSidePaneStore.getState().back();
    expect(useSidePaneStore.getState().stack).toEqual([{ kind: 'entity', ref: company }]);
  });

  it('collapses without losing the subject and can reopen it', () => {
    useSidePaneStore.getState().open({ kind: 'entity', ref: company });
    useSidePaneStore.getState().collapse();

    expect(useSidePaneStore.getState().stack).toEqual([{ kind: 'entity', ref: company }]);
    expect(useSidePaneStore.getState().isOpen).toBe(false);

    useSidePaneStore.getState().reopen();
    expect(useSidePaneStore.getState().isOpen).toBe(true);
  });

  it('can open an empty pane directly from the chat toolbar', () => {
    useSidePaneStore.getState().reopen();

    expect(useSidePaneStore.getState().stack).toEqual([]);
    expect(useSidePaneStore.getState().isOpen).toBe(true);
  });

  it('fully clears retained content when the conversation changes', () => {
    useSidePaneStore.getState().open({ kind: 'entity', ref: company });
    useSidePaneStore.getState().close();

    expect(useSidePaneStore.getState().stack).toEqual([]);
    expect(useSidePaneStore.getState().isOpen).toBe(false);
  });

  it('ignores a re-open of the record already on top', () => {
    // Otherwise the user has to press Back twice to escape one click.
    const { open } = useSidePaneStore.getState();
    open({ kind: 'entity', ref: company });
    open({ kind: 'entity', ref: company });

    expect(useSidePaneStore.getState().stack).toHaveLength(1);
  });

  it('replaces rather than stacks for previews', () => {
    // "Show me that other page" is a swap; a back-stack of HTML previews is
    // history nobody asked for.
    const { open } = useSidePaneStore.getState();
    open({ kind: 'entity', ref: company });
    open({ kind: 'html', code: '<p>a</p>' });
    open({ kind: 'html', code: '<p>b</p>' });

    expect(useSidePaneStore.getState().stack).toEqual([{ kind: 'html', code: '<p>b</p>' }]);
  });

  it.each([
    ['collapse', () => useSidePaneStore.getState().collapse()],
    ['close', () => useSidePaneStore.getState().close()],
  ])('drops full screen on %s', (_label, leave) => {
    // Otherwise restoring from the TopBar hands back a pane that swallows the
    // whole window, with no memory of having asked for that.
    useSidePaneStore.getState().open({ kind: 'html', code: '<p>a</p>' });
    useSidePaneStore.getState().setFullscreen(true);
    expect(useSidePaneStore.getState().isFullscreen).toBe(true);

    leave();
    expect(useSidePaneStore.getState().isFullscreen).toBe(false);
  });

  it('caps width to a fraction of the viewport so the composer stays usable', () => {
    expect(maxSidePaneWidth(1600)).toBe(960);
    // Never below the minimum, even on a viewport narrower than it.
    expect(maxSidePaneWidth(400)).toBe(SIDE_PANE_MIN_WIDTH);
  });
});
