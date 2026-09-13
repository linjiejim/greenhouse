import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { OverlayPanel } from './overlay-panel';

describe('OverlayPanel inactive state', () => {
  it('keeps a persisted panel hidden and inert while inactive', () => {
    const html = renderToStaticMarkup(
      createElement(OverlayPanel, {
        active: false,
        onClose: vi.fn(),
        ariaLabel: 'Assistant',
        children: createElement('p', null, 'Persisted conversation'),
      }),
    );

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="Assistant"');
    expect(html).toContain('mobile-visual-viewport');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('inert=""');
    expect(html).not.toContain('aria-modal="true"');
  });

  it('keeps bottom sheets inside the visible mobile viewport too', () => {
    const html = renderToStaticMarkup(
      createElement(OverlayPanel, {
        active: true,
        onClose: vi.fn(),
        ariaLabel: 'Agent picker',
        variant: 'bottom',
        children: createElement('p', null, 'Agents'),
      }),
    );

    expect(html).toContain('mobile-visual-viewport');
    expect(html).toContain('aria-label="Agent picker"');
  });

  it('removes inert and publishes modal semantics while active', () => {
    const html = renderToStaticMarkup(
      createElement(OverlayPanel, {
        active: true,
        onClose: vi.fn(),
        ariaLabel: 'Assistant',
        children: createElement('p', null, 'Active conversation'),
      }),
    );

    expect(html).toContain('aria-modal="true"');
    expect(html).not.toContain('aria-hidden="true"');
    expect(html).not.toContain('inert=""');
  });

  it('uses anchored enter and exit motion without exposing a closing panel', () => {
    const entering = renderToStaticMarkup(
      createElement(OverlayPanel, {
        active: true,
        onClose: vi.fn(),
        ariaLabel: 'Assistant',
        motionState: 'enter',
        children: createElement('p', null, 'Entering'),
      }),
    );
    const exiting = renderToStaticMarkup(
      createElement(OverlayPanel, {
        active: false,
        onClose: vi.fn(),
        ariaLabel: 'Assistant',
        motionState: 'exit',
        children: createElement('p', null, 'Exiting'),
      }),
    );

    expect(entering).toContain('animate-panel-enter');
    expect(entering).toContain('animate-backdrop-fade');
    expect(exiting).toContain('animate-panel-exit');
    expect(exiting).toContain('animate-backdrop-fade-out');
    expect(exiting).toContain('aria-hidden="true"');
    expect(exiting).toContain('inert=""');
    expect(exiting).toContain('pointer-events-none');
  });
});
