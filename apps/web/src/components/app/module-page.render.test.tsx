import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { ModulePage } from './module-page';

function renderPage(locale: 'en' | 'zh' = 'en', layout: 'form' | 'list' | 'canvas' = 'list') {
  return renderToStaticMarkup(
    <I18nProvider initialLocale={locale}>
      <ModulePage
        moduleId="admin.users"
        layout={layout}
        actions={<button>Action slot</button>}
        notice={<div>Notice slot</div>}
        tabs={<div>Tabs slot</div>}
        toolbar={<div>Toolbar slot</div>}
      >
        Content slot
      </ModulePage>
    </I18nProvider>,
  );
}

describe('ModulePage', () => {
  it('derives localized page identity from the navigation registry', () => {
    const english = renderPage();
    const chinese = renderPage('zh');

    expect(english).toContain('App user management');
    expect(chinese).toContain('App 用户管理');
    expect(english).toContain('data-module-page="admin.users"');
    expect(english).toContain('data-module-page-layout="list"');
    expect(english).toContain('truncate text-base');
    expect(english).toContain('truncate text-xs');
    expect(english).toContain('title="App user management"');
  });

  it('renders stable page slots in the intended order', () => {
    const html = renderPage();
    const slotOrder = ['Action slot', 'Notice slot', 'Tabs slot', 'Toolbar slot', 'Content slot'].map((text) =>
      html.indexOf(text),
    );

    expect(slotOrder.every((position) => position >= 0)).toBe(true);
    expect(slotOrder).toEqual([...slotOrder].sort((a, b) => a - b));
    expect(html).toContain('max-w-[80rem]');
    expect(html).toContain('sm:[&amp;_button]:w-auto');
  });

  it('pins the width and scroll contract for every supported layout', () => {
    const form = renderPage('en', 'form');
    const list = renderPage('en', 'list');
    const canvas = renderPage('en', 'canvas');

    expect(form).toContain('data-module-page-layout="form"');
    expect(form).toContain('max-w-[60rem]');
    expect(form).toContain('h-full overflow-y-auto');

    expect(list).toContain('data-module-page-layout="list"');
    expect(list).toContain('max-w-[80rem]');
    expect(list).toContain('h-full overflow-y-auto');

    expect(canvas).toContain('data-module-page-layout="canvas"');
    expect(canvas).toContain('max-w-none');
    expect(canvas).toContain('h-full overflow-hidden');
    expect(canvas).toContain('min-h-0 flex-1 overflow-hidden');
  });
});
