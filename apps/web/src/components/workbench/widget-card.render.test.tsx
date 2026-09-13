import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { WorkbenchWidget } from '@greenhouse/types/workbench';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { WidgetCard } from './widget-card';

const widget: WorkbenchWidget = {
  id: 'sales',
  kind: 'data',
  title: 'Yesterday’s sales',
  display: 'kpi',
  source: { toolId: 'restricted_query', input: {} },
  map: { value: 'total' },
  layout: { tabId: 'main', x: 0, y: 0, w: 3, h: 2 },
};

function renderCard() {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(WidgetCard, {
        widget,
        state: {},
        applications: [],
        editing: false,
        onEdit: vi.fn(),
        onRemove: vi.fn(),
        onRefresh: vi.fn(),
      }),
    }),
  );
}

describe('WidgetCard density', () => {
  it('keeps the title bar compact even when the hidden refresh action is mounted', () => {
    const html = renderCard();

    expect(html).toContain('px-3 py-1');
    expect(html).toContain('h-7 w-7');
    expect(html).not.toContain('h-11 w-11 sm:h-9 sm:w-9');
  });
});
