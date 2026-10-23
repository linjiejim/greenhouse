import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { ExecutionCenterLink } from './execution-center-link';

function render(compact = false, active = false, locale: 'en' | 'zh' = 'en') {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: locale,
      children: createElement(ExecutionCenterLink, { compact, active }),
    }),
  );
}

describe('ExecutionCenterLink (Activity log entry)', () => {
  it('opens the Activity log', () => {
    const html = render();
    expect(html).toContain('href="#/activity"');
    expect(html).toContain('>Activity log<');
    expect(render(false, false, 'zh')).toContain('>操作记录<');
  });

  it('keeps the fixed destination usable in the collapsed sidebar', () => {
    const html = render(true, true);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="Activity log"');
  });

  it('renders as an account-flyout menu item when requested', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ExecutionCenterLink, { active: false, menu: true }),
      }),
    );
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('>Activity log<');
  });
});
