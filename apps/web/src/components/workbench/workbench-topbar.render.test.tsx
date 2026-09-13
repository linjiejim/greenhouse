/**
 * The workbench's Customize control lives in the TopBar, but the panel
 * owns them and hands them over only while it is mounted. This pins both ends:
 * nothing is drawn without a registered panel (sending the first message
 * unmounts it, and two dead buttons pointing at a grid that is gone would be
 * worse than none), and the label follows the edit state.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { TopBar } from '../app/top-bar';
import { WorkbenchTopBarActions, type WorkbenchTopBarControls } from './workbench-topbar-actions';

function render(controls: WorkbenchTopBarControls | null) {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(WorkbenchTopBarActions, { controls }),
    }),
  );
}

const idle: WorkbenchTopBarControls = { editing: false, onToggleEdit: vi.fn() };

describe('workbench TopBar actions', () => {
  it('draws nothing when no panel is mounted', () => {
    expect(render(null)).toBe('');
  });

  it('offers Customize as an icon-only action while a panel is mounted', () => {
    const html = render(idle);
    const button = html.match(/<button[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(html).toContain('aria-label="Customize"');
    expect(html).toContain('aria-pressed="false"');
    expect(button).not.toContain('Customize</');
    expect(html).not.toContain('aria-label="Refresh"');
  });

  it('switches to Done while editing', () => {
    const html = render({ ...idle, editing: true });
    expect(html).toContain('aria-label="Done"');
    expect(html).toContain('aria-pressed="true"');
  });

  it('stays out of the TopBar until a panel registers', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(TopBar, { route: 'chat' as const, onSelectSession: vi.fn() }),
      }),
    );
    expect(html).not.toContain('Customize');
    expect(html).not.toContain('aria-label="Refresh"');
  });
});
