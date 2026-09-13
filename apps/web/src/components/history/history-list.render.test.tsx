import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { HistoryList } from './history-list';
import type { HistorySession } from './filter-model';

function session(overrides: Partial<HistorySession>): HistorySession {
  return {
    id: 'session-12345678',
    title: 'Example conversation',
    status: 'active',
    profile_id: 'sprouty',
    updated_at: '2026-08-07T01:00:00.000Z',
    feedback: null,
    rating: null,
    comment: null,
    ...overrides,
  } as HistorySession;
}

function renderList(sessions: HistorySession[]) {
  return renderToStaticMarkup(
    createElement(I18nProvider, {
      initialLocale: 'en',
      children: createElement(HistoryList, {
        sessions,
        total: sessions.length,
        page: 0,
        pageSize: 20,
        onPageChange: vi.fn(),
        onPageSizeChange: vi.fn(),
        loading: false,
        status: 'active',
        onOpen: vi.fn(),
        onEdit: vi.fn(),
        onStatusChange: vi.fn(),
        onDelete: vi.fn(),
      }),
    }),
  );
}

describe('HistoryList row metadata', () => {
  it('omits redundant status and ordinary agent-profile tags', () => {
    const html = renderList([session({})]);

    expect(html).not.toContain('>Active<');
    expect(html).not.toContain('>sprouty<');
  });

  it('reuses the sidebar session-type icon for historical cloud sessions', () => {
    const html = renderList([session({ profile_id: 'sprouty-mission' })]);

    expect(html).toContain('title="Cloud mission"');
    expect(html).not.toContain('>sprouty-mission<');
  });
});
