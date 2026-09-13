import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { ExecutionCenterLink } from './execution-center-link';

vi.mock('../../hooks/use-runtime-attention-count', () => ({
  useRuntimeAttentionCount: () => 3,
}));

function render(compact = false, active = false) {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(ExecutionCenterLink, { compact, active }),
    }),
  );
}

describe('ExecutionCenterLink', () => {
  it('deep-links a visible attention count into the canonical execution URL', () => {
    const html = render();
    expect(html).toContain('href="#/executions?tab=attention"');
    expect(html).toContain('>Execution Center<');
    expect(html).toContain('>3<');
  });

  it('keeps the fixed destination usable in the collapsed sidebar', () => {
    const html = render(true, true);
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('aria-label="Execution Center"');
  });

  it('renders as an account-flyout menu item when requested', () => {
    const html = renderToStaticMarkup(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(ExecutionCenterLink, { active: false, menu: true }),
      }),
    );
    expect(html).toContain('role="menuitem"');
    expect(html).toContain('>Execution Center<');
  });
});
