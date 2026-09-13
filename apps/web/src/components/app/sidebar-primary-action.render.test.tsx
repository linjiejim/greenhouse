import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Plus } from '../../lib/icons';
import { SidebarBackButton, SidebarBrandHeader, SidebarCollapseButton } from './app-sidebar';
import { SidebarPrimaryAction } from './sidebar-primary-action';
import { I18nProvider } from '../../lib/i18n';

function render(ui: ReactNode) {
  return renderToStaticMarkup(<I18nProvider initialLocale="en">{ui}</I18nProvider>);
}

describe('SidebarPrimaryAction', () => {
  it('provides the shared centered primary style used by New Chat and New Base', () => {
    const newChat = renderToStaticMarkup(
      <SidebarPrimaryAction icon={Plus} onClick={vi.fn()}>
        New Chat
      </SidebarPrimaryAction>,
    );
    const newBase = renderToStaticMarkup(
      <SidebarPrimaryAction icon={Plus} onClick={vi.fn()}>
        New Base
      </SidebarPrimaryAction>,
    );

    for (const html of [newChat, newBase]) {
      expect(html).toContain('justify-center');
      expect(html).toContain('rounded-lg');
      expect(html).toContain('bg-primary-500');
      expect(html).toContain('hover:bg-primary-600');
    }
    expect(newChat).toContain('New Chat');
    expect(newBase).toContain('New Base');
  });

  it('keeps global actions by the brand and exposes a separate bottom-row collapse control', () => {
    const expanded = render(
      <SidebarBrandHeader
        collapsed={false}
        globalActions={
          <>
            <button aria-label="Global Search" />
            <button aria-label="Global Agent" />
          </>
        }
      />,
    );
    const collapsed = render(<SidebarBrandHeader collapsed onToggle={vi.fn()} />);
    const collapseControl = render(<SidebarCollapseButton onClick={vi.fn()} />);

    expect(expanded).toContain('favicon.svg');
    expect(expanded).toContain('Greenhouse');
    expect(expanded).toContain('AI-native workbench');
    expect(expanded).not.toContain('Localhost');
    expect(expanded).not.toContain('bg-primary-900');
    expect(expanded).not.toContain('aria-label="Collapse sidebar"');
    expect(expanded).not.toContain('lucide-panel-left-close');
    expect(expanded).toContain('aria-label="Global Search"');
    expect(expanded).toContain('aria-label="Global Agent"');
    expect(expanded.indexOf('Global Search')).toBeLessThan(expanded.indexOf('Global Agent'));
    expect(collapsed).not.toContain('aria-label="Greenhouse home"');
    expect(collapsed).not.toContain('favicon.svg');
    expect(collapsed).not.toContain('Greenhouse');
    expect(collapsed).not.toContain('bg-primary-900');
    expect(collapsed).toContain('aria-label="Expand sidebar"');
    expect(collapsed).toContain('lucide-panel-left-open');
    expect(collapseControl).toContain('aria-label="Collapse sidebar"');
    expect(collapseControl).toContain('lucide-panel-left-close');
    expect(expanded).not.toContain('lucide-chevron-left');
    expect(collapsed).not.toContain('lucide-chevron-right');
  });

  it('keeps page navigation as an explicit back arrow in both rail widths', () => {
    const expanded = render(<SidebarBackButton onClick={vi.fn()} />);
    const collapsed = render(<SidebarBackButton onClick={vi.fn()} compact />);

    for (const html of [expanded, collapsed]) {
      expect(html).toContain('aria-label="Back"');
      expect(html).toContain('lucide-arrow-left');
      expect(html).not.toContain('lucide-panel-left');
    }
    expect(expanded).toContain('>Back</span>');
  });
});
