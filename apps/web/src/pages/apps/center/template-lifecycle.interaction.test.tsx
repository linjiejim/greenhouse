/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppTemplateDetailView } from '@greenhouse/types/apps';
import { I18nProvider } from '../../../lib/i18n';
import { TemplateDetailDialog } from './template-detail-dialog';
import { TemplateDialog } from './template-dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const api = vi.hoisted(() => ({ getAppTemplate: vi.fn(), reviewAppTemplate: vi.fn(), archiveAppTemplate: vi.fn() }));
vi.mock('../../../lib/api/app-templates', () => api);
const catalog = vi.hoisted(() => ({ listAppTemplates: vi.fn(), installAppTemplate: vi.fn() }));
vi.mock('../../../lib/api/apps', async (original) => ({ ...(await original<object>()), ...catalog }));

const detail: AppTemplateDetailView = {
  template: {
    key: 'review-me',
    name: 'Review me',
    description: 'Template',
    icon: 'table',
    accent: 'teal',
    source: 'published',
    version: '1.2.0',
    reviewStatus: 'pending',
    status: 'active',
    owner: { id: 'owner', name: 'Owner' },
    canManage: true,
    canReview: true,
  },
  versions: [
    {
      version: '1.2.0',
      changelog: 'Added a custom view',
      contentHash: 'abc123',
      scanStatus: 'suspicious',
      reviewStatus: 'pending',
      carries: { customCards: 1, automations: 0 },
      publishedBy: { id: 'owner', name: 'Owner' },
      publishedAt: '2026-10-12T00:00:00Z',
    },
  ],
  review: { version: '1.2.0', content: '{"immutable":"source"}', scanFindings: [{ reason: 'Review this content' }] },
};
let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  api.getAppTemplate.mockReset().mockResolvedValue(detail);
  api.reviewAppTemplate.mockReset().mockResolvedValue(detail.versions[0]);
  api.archiveAppTemplate.mockReset();
  catalog.listAppTemplates.mockReset().mockResolvedValue([detail.template]);
  catalog.installAppTemplate.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

it('reviews the exact displayed version and explains that custom HTML remains unavailable', async () => {
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="en">
        <TemplateDetailDialog templateKey="review-me" onClose={() => {}} />
      </I18nProvider>,
    ),
  );
  expect(document.body.textContent).toContain('abc123');
  expect(document.body.textContent).toContain('immutable');
  expect(document.body.textContent).toContain('Execution is currently unavailable');
  const approve = document.querySelector<HTMLButtonElement>('[data-testid="template-approve"]')!;
  await act(async () => approve.click());
  expect(api.reviewAppTemplate).toHaveBeenCalledWith('review-me', '1.2.0', { decision: 'approve', note: '' });
});

it('does not offer installation until review is approved, while keeping details available', async () => {
  await act(async () =>
    root.render(
      <I18nProvider initialLocale="en">
        <TemplateDialog open templates={[detail.template]} onClose={() => {}} />
      </I18nProvider>,
    ),
  );
  const install = document.querySelector<HTMLButtonElement>('[data-testid="template-review-me-install"]')!;
  expect(install.disabled).toBe(true);
  const inspect = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Details and review',
  )!;
  await act(async () => inspect.click());
  expect(api.getAppTemplate).toHaveBeenCalledWith('review-me', undefined);
  expect(catalog.installAppTemplate).not.toHaveBeenCalled();
});
