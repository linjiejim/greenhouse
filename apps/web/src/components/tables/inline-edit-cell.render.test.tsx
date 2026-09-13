import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { InlineEditCell } from './inline-edit-cell';

describe('InlineEditCell', () => {
  it('offers editing through an explicit button plus the keyboard', () => {
    const html = renderToStaticMarkup(
      <InlineEditCell label="Customer" value="Greenhouse" onCommit={vi.fn()}>
        <span>Greenhouse</span>
      </InlineEditCell>,
    );

    expect(html).toContain('<button');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Edit Customer"');
    expect(html).toContain('Click the pencil to edit · Enter or F2');
    // Hidden until hover, but reachable on touch devices where hover never fires.
    expect(html).toContain('touch-visible');
  });

  it('leaves the click to the row so viewing a record still works', () => {
    const html = renderToStaticMarkup(
      <InlineEditCell label="Customer" value="Greenhouse" onCommit={vi.fn()}>
        <span>Greenhouse</span>
      </InlineEditCell>,
    );

    // The old double-click affordance had to swallow single clicks to tell the
    // two apart; nothing may reintroduce that.
    expect(html).not.toContain('cursor-cell');
    expect(html).not.toContain('Double-click');
  });

  it('renders a read-only cell without editing semantics', () => {
    const html = renderToStaticMarkup(
      <InlineEditCell label="Computed" value="42" canEdit={false} onCommit={vi.fn()}>
        <span>42</span>
      </InlineEditCell>,
    );

    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-label="Edit Computed"');
    expect(html).not.toContain('cursor-cell');
  });

  it('renders a labelled one-click boolean switch when quickToggle is enabled', () => {
    const html = renderToStaticMarkup(
      <InlineEditCell label="Active" value inputType="boolean" quickToggle onCommit={vi.fn()}>
        Yes
      </InlineEditCell>,
    );

    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Active"');
    expect(html).not.toContain('Click the pencil to edit');
  });
});
