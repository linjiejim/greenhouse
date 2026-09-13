import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../lib/i18n';
import { BatchActionBar } from './batch-action-bar';

function render(props: Partial<React.ComponentProps<typeof BatchActionBar>> = {}) {
  return renderToStaticMarkup(
    <I18nProvider initialLocale="en">
      <BatchActionBar
        count={3}
        busy={false}
        onTag={vi.fn()}
        onMove={vi.fn()}
        onArchive={vi.fn()}
        onDelete={vi.fn()}
        onDone={vi.fn()}
        onSelectAll={vi.fn()}
        onClear={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

const disabledCount = (html: string) => (html.match(/disabled=""/g) ?? []).length;

describe('BatchActionBar', () => {
  it('shows the interpolated selection count', () => {
    expect(render({ count: 5 })).toContain('5 selected');
  });

  it('renders all four batch actions plus Done', () => {
    const html = render();
    for (const label of ['Tag', 'Move', 'Archive', 'Delete', 'Done']) {
      expect(html).toContain(label);
    }
  });

  it('enables every control when items are selected and not busy', () => {
    expect(disabledCount(render({ count: 3, busy: false }))).toBe(0);
  });

  it('disables all controls while a batch is running', () => {
    // 4 actions + Done + Select all + Clear.
    expect(disabledCount(render({ busy: true }))).toBe(7);
  });

  it('disables the actions when nothing is selected, but Done and Select all stay usable', () => {
    const html = render({ count: 0, busy: false });
    // 4 actions + Clear (count===0). Done and Select all remain enabled.
    expect(disabledCount(html)).toBe(5);
    expect(html).toContain('0 selected');
    expect(html).toContain('Done');
  });

  it('marks the delete action as destructive with a danger token', () => {
    expect(render()).toContain('text-danger');
  });
});
