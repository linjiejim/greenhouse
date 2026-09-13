import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { History } from '../../lib/icons';
import { I18nProvider } from '../../lib/i18n';
import { SidebarToolbar } from './sidebar-toolbar';

describe('SidebarToolbar', () => {
  it('lets search surrender width without clipping the fixed action row', () => {
    const html = renderToStaticMarkup(
      <I18nProvider initialLocale="en">
        <SidebarToolbar
          value=""
          onChange={vi.fn()}
          placeholder="Search"
          actions={[
            { label: 'One', icon: History, onClick: vi.fn() },
            { label: 'Two', icon: History, onClick: vi.fn() },
            { label: 'Three', icon: History, onClick: vi.fn() },
            { label: 'View All', icon: History, onClick: vi.fn() },
          ]}
        />
      </I18nProvider>,
    );

    expect(html).toContain('min-w-0 basis-0 flex-1');
    expect(html).toContain('flex-shrink-0 items-center overflow-hidden');
    expect(html.match(/h-7 w-7/g)).toHaveLength(5);
    expect(html).toContain('aria-label="View All"');
  });
});
