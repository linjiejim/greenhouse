import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Dialog, Drawer, FilterPills, IconButton, ResizeHandle, Tabs } from './ui';

describe('responsive UI primitives', () => {
  it('renders icon actions with an accessible 44px mobile target', () => {
    const html = renderToStaticMarkup(
      createElement(IconButton, {
        label: 'Open actions',
        children: createElement('span', null, '…'),
      }),
    );

    expect(html).toContain('aria-label="Open actions"');
    expect(html).toContain('h-11');
    expect(html).toContain('w-11');
    expect(html).toContain('top-full mt-1.5');
    expect(html).not.toContain('bottom-full mb-1.5');
  });

  it('renders a keyboard-accessible resize separator with value metadata', () => {
    const html = renderToStaticMarkup(
      createElement(ResizeHandle, {
        orientation: 'vertical',
        value: 200,
        min: 160,
        max: 420,
        defaultValue: 200,
        onChange: vi.fn(),
        label: 'Resize sidebar',
      }),
    );

    expect(html).toContain('role="separator"');
    expect(html).toContain('aria-orientation="vertical"');
    expect(html).toContain('aria-valuenow="200"');
    expect(html).toContain('tabindex="0"');
  });

  it('adds a select fallback when filter pills are used in a narrow sidebar', () => {
    const html = renderToStaticMarkup(
      createElement(FilterPills, {
        items: [
          { key: 'all', label: 'All' },
          { key: 'private', label: 'Private', count: 2 },
        ],
        activeKey: 'all',
        onChange: vi.fn(),
        collapseInSidebar: true,
        selectLabel: 'Conversation tag filter',
      }),
    );

    expect(html).toContain('sidebar-filter-pills');
    expect(html).toContain('sidebar-filter-select');
    expect(html).toContain('aria-label="Conversation tag filter"');
    expect(html).toContain('Private (2)');
  });

  it('wraps filter pills without rendering a select fallback', () => {
    const html = renderToStaticMarkup(
      createElement(FilterPills, {
        items: [
          { key: 'all', label: 'All' },
          { key: 'public', label: 'Public', count: 600 },
        ],
        activeKey: 'all',
        onChange: vi.fn(),
        wrap: true,
      }),
    );

    expect(html).toContain('flex-wrap');
    expect(html).toContain('overflow-visible');
    expect(html).toContain('border-edge');
    expect(html).not.toContain('<select');
  });

  it('can distribute a compact segment control across the full sidebar width', () => {
    const html = renderToStaticMarkup(
      createElement(FilterPills, {
        items: [
          { key: 'mine', label: 'Mine' },
          { key: 'shared', label: 'Shared' },
          { key: 'team', label: 'Team' },
        ],
        activeKey: 'mine',
        onChange: vi.fn(),
        variant: 'segment',
        fill: true,
      }),
    );

    expect(html).toContain('w-full');
    expect(html.match(/min-w-0 flex-1 justify-center/g)).toHaveLength(3);
  });

  it('renders shared tabs with selection and keyboard semantics', () => {
    const html = renderToStaticMarkup(
      createElement(Tabs, {
        tabs: [
          { key: 'overview', label: 'Overview' },
          { key: 'global', label: 'Global' },
        ],
        active: 'overview',
        onChange: vi.fn(),
        ariaLabel: 'Dashboard views',
      }),
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-label="Dashboard views"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('tabindex="-1"');
  });

  it('bounds dialog height by the padded container, not a hard-coded dvh offset', () => {
    // 回归护栏：曾经写死 max-h-[calc(100dvh-1rem)]，但容器 padding 是
    // max(0.5rem, env(safe-area-inset-*))。刘海机上 safe-area 有 59px + 34px，
    // 弹框因此比可用空间高出近 80px，而移动端 items-end 底部对齐会把溢出部分
    // 从顶部顶出屏幕——标题栏连同关闭按钮一起消失，弹框再也关不掉。
    const html = renderToStaticMarkup(
      createElement(Dialog, {
        open: true,
        onClose: vi.fn(),
        title: 'History',
        children: createElement('p', null, 'Long list'),
      }),
    );

    expect(html).toContain('max-h-full');
    expect(html).not.toContain('100dvh');
    // 容器仍必须消费 safe-area，否则 max-h-full 也算不出正确的可用高度。
    expect(html).toContain('env(safe-area-inset-top)');
    expect(html).toContain('env(safe-area-inset-bottom)');
  });

  it('keeps a tabbed dialog inside the viewport instead of a fixed dvh height', () => {
    const html = renderToStaticMarkup(
      createElement(Dialog, {
        open: true,
        onClose: vi.fn(),
        title: 'Permissions',
        tabs: createElement('div', null, 'tabs'),
        children: createElement('p', null, 'body'),
      }),
    );

    expect(html).toContain('h-[min(44rem,100%)]');
    expect(html).not.toContain('100dvh');
  });

  it('renders dense workflows in the shared 80vw dialog workspace', () => {
    const html = renderToStaticMarkup(
      createElement(Dialog, {
        open: true,
        onClose: vi.fn(),
        title: 'Edit history',
        size: 'workspace',
        children: createElement('p', null, 'Compare versions'),
      }),
    );

    expect(html).toContain('sm:w-[80vw]');
    expect(html).toContain('sm:max-w-[80vw]');
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Edit history"');
  });

  it('keeps mobile drawers inside the visible keyboard viewport', () => {
    const html = renderToStaticMarkup(
      createElement(Drawer, {
        open: true,
        onClose: vi.fn(),
        ariaLabel: 'Navigation',
        children: createElement('input', { 'aria-label': 'Search conversations' }),
      }),
    );

    expect(html).toContain('mobile-visual-viewport');
    expect(html).toContain('aria-label="Navigation"');
  });
});
