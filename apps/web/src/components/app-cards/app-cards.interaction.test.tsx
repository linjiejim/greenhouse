/** @vitest-environment happy-dom */

/**
 * Every app card kind against the gateway contract (mocked results, a spy
 * host): what it draws from the role's rows and labels, and which host call
 * each gesture becomes — a row opens its detail, a card-face action runs, a
 * kanban drag is a move, a form submits its values (required fields first),
 * buttons open pages / safe links / the create form. Shared states: broken
 * by a schema change, not readable by the role, failed.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppCard, AppCardQueryResult } from '@greenhouse/types/apps';
import { I18nProvider } from '../../lib/i18n';
import { dragTo, flush } from '../../pages/tables/views/view-test-fixtures';
import { resetRecordCoverCacheForTest } from '../../pages/tables/views/record-cover';
import { AppCardView } from './app-card-view';
import { CARDS, CHAIR, LAPTOP, mockHost, recordsResult, runtimeView, stateOf } from './test-fixtures';
import type { AppCardHost } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ authFetch: vi.fn(), aggregateTableRecords: vi.fn(), openCardUrl: vi.fn() }));
vi.mock('../../lib/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/auth')>()),
  authFetch: mocks.authFetch,
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  aggregateTableRecords: mocks.aggregateTableRecords,
}));
vi.mock('../../lib/rich-output', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/rich-output')>()),
  openCardUrl: mocks.openCardUrl,
}));

let root: Root | null = null;
let container: HTMLDivElement;
const createObjectURL = URL.createObjectURL;
const revokeObjectURL = URL.revokeObjectURL;

async function mount(card: AppCard, host: AppCardHost, result?: AppCardQueryResult, error: string | null = null) {
  container = document.createElement('div');
  container.style.height = '600px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <I18nProvider initialLocale="en">
        <div style={{ height: 600 }}>
          <AppCardView card={card} host={host} state={result || error ? stateOf(result, error) : undefined} />
        </div>
      </I18nProvider>,
    ),
  );
  await flush();
}

const click = async (element: Element | null | undefined) => {
  expect(element, 'element to click').toBeTruthy();
  await act(async () => (element as HTMLElement).click());
};
const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const buttonNamed = (label: string) =>
  [...container.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === label);

async function type(element: Element | null, value: string) {
  const input = element as HTMLInputElement | HTMLTextAreaElement;
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input) as object, 'value')?.set;
  await act(async () => {
    setter?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  resetRecordCoverCacheForTest();
  URL.createObjectURL = vi.fn(() => 'blob:cover');
  URL.revokeObjectURL = vi.fn();
  mocks.authFetch.mockImplementation(async () => new Response('png', { headers: { 'content-type': 'image/png' } }));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('records card', () => {
  it('draws the role’s rows with gateway labels and offers only the actions each row allows', async () => {
    const host = mockHost();
    await mount(CARDS.mine, host, recordsResult());

    const text = container.textContent ?? '';
    expect(text).toContain('My requests');
    expect(text).toContain('Laptop');
    expect(text).toContain('1,200');
    // An attachment shows its name from the refs, never only an id.
    expect(text).toContain('quote.pdf');
    // Approve / Reject only where the gateway offered them (`actionIds`).
    expect(byTestId('app-action-11-approve')).not.toBeNull();
    expect(byTestId('app-action-12-approve')).toBeNull();

    await click(byTestId('app-action-11-approve'));
    expect(host.runAction).toHaveBeenCalledWith(CARDS.mine, CARDS.mine.actions[0], LAPTOP);
    expect(host.openRecord).not.toHaveBeenCalled();

    await click(container.querySelector('button[aria-label="Open Chair"]'));
    expect(host.openRecord).toHaveBeenCalledWith(CARDS.mine, CHAIR);

    await click(byTestId('app-card-mine-new'));
    expect(host.openCreate).toHaveBeenCalledWith(CARDS.mine);
  });

  it('searches after a pause and pages with the gateway cursor', async () => {
    vi.useFakeTimers();
    const host = mockHost();
    await mount(CARDS.mine, host, recordsResult([LAPTOP], 'cursor-2'));

    await type(container.querySelector('input[aria-label="Search My requests"]'), 'lap');
    expect(host.setParams).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTime(400));
    expect(host.setParams).toHaveBeenCalledWith(CARDS.mine, { search: 'lap' });

    await click(buttonNamed('Next'));
    expect(host.setParams).toHaveBeenLastCalledWith(CARDS.mine, { search: 'lap', cursor: 'cursor-2' });
  });

  it('draws the list display with titles and fields', async () => {
    await mount(CARDS.list, mockHost(), recordsResult());
    const items = [...container.querySelectorAll('li')].map((item) => item.textContent);
    expect(items[0]).toContain('Laptop');
    expect(items[0]).toContain('Amount');
    // No detail declared: titles are not links.
    expect(container.querySelector('[data-testid="app-record-open-11"]')).toBeNull();
  });
});

describe('kanban, calendar and gallery cards (the Tables view bodies)', () => {
  it('lays the rows in lanes, puts actions on the card faces and turns a drag into a move', async () => {
    const host = mockHost();
    await mount(CARDS.board, host, recordsResult());

    const lane = (key: string) => byTestId(`kanban-lane-${key}`)!;
    expect(lane('pending').contains(byTestId('kanban-card-11'))).toBe(true);
    expect(lane('approved').contains(byTestId('kanban-card-12'))).toBe(true);
    // Counts are the loaded rows: an app viewer has no Tables aggregate to ask.
    expect(mocks.aggregateTableRecords).not.toHaveBeenCalled();
    expect(lane('pending').querySelector('[data-testid="kanban-lane-count"]')?.textContent).toBe('1');

    await click(byTestId('app-action-11-reject'));
    expect(host.runAction).toHaveBeenCalledWith(CARDS.board, CARDS.board.actions[1], LAPTOP);
    expect(host.openRecord).not.toHaveBeenCalled();

    await dragTo(byTestId('kanban-card-11')!, lane('rejected').querySelector('header'));
    expect(host.move).toHaveBeenCalledWith(CARDS.board, LAPTOP, 2, 'rejected');

    await click(byTestId('kanban-card-12'));
    expect(host.openRecord).toHaveBeenCalledWith(CARDS.board, CHAIR);
  });

  it('does not drag a board the role may not move on', async () => {
    const host = mockHost();
    const { move: _move, ...still } = CARDS.board;
    await mount(still, host, recordsResult());
    await dragTo(byTestId('kanban-card-11')!, byTestId('kanban-lane-rejected')!.querySelector('header'));
    expect(host.move).not.toHaveBeenCalled();
  });

  it('places rows on the calendar by the start field', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-11T12:00:00'));
    await mount(CARDS.due, mockHost(), recordsResult());
    expect(byTestId('calendar-day-2026-10-15')?.textContent).toContain('Laptop');
  });

  it('reads gallery covers through the app’s file route', async () => {
    const host = mockHost();
    await mount(CARDS.photos, host, recordsResult());
    await flush();
    expect(host.fileUrl).toHaveBeenCalledWith(CARDS.photos, 11, 4, 31);
    expect(mocks.authFetch).toHaveBeenCalledWith('/api/apps/5/files/31?recordId=11&fieldId=4');
    expect(mocks.authFetch.mock.calls.some(([url]) => String(url).includes('/api/drive/'))).toBe(false);
  });
});

describe('form card', () => {
  it('asks for required fields first, then submits the values and thanks the person', async () => {
    const host = mockHost();
    await mount(CARDS.apply, host);

    await click(byTestId('app-form-apply-submit'));
    expect(host.submitForm).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Fill in the required fields.');

    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    await type(inputs[0]!, 'Monitor');
    await type(inputs[1]!, '300');
    await act(async () => {
      const file = new File(['x'], 'quote.pdf', { type: 'application/pdf' });
      const picker = container.querySelector('[data-testid="attachment-upload-input"]') as HTMLInputElement;
      Object.defineProperty(picker, 'files', { value: [file], configurable: true });
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(host.upload).toHaveBeenCalledWith(CARDS.apply, 4, expect.any(File));

    await click(byTestId('app-form-apply-submit'));
    expect(host.submitForm).toHaveBeenCalledWith(CARDS.apply, [
      { fieldId: 1, value: 'Monitor' },
      { fieldId: 3, value: 300 },
      { fieldId: 4, value: [77] },
    ]);
    expect(byTestId('app-form-apply-done')?.textContent).toContain('Finance will look at it.');
    await click(buttonNamed('Submit another'));
    expect(byTestId('app-form-apply-submit')?.textContent).toBe('Send request');
  });

  it('shows a refusal in the form', async () => {
    const host = mockHost({
      submitForm: vi.fn(async () => Promise.reject(new Error('Your role cannot add requests'))),
    });
    await mount(CARDS.apply, host);
    const inputs = [...container.querySelectorAll('input')] as HTMLInputElement[];
    await type(inputs[0]!, 'Monitor');
    await click(byTestId('app-form-apply-submit'));
    expect(container.textContent).toContain('Your role cannot add requests');
  });
});

describe('aggregate, text and buttons cards', () => {
  it('draws a KPI from the gateway’s answer and the text card’s Markdown', async () => {
    await mount(CARDS.total, mockHost(), { kind: 'kpi', value: 1290 });
    expect(container.textContent).toContain('1,290');
    act(() => root?.unmount());
    container.remove();
    await mount(CARDS.intro, mockHost());
    expect(container.querySelector('strong')?.textContent).toBe('Ask');
  });

  it('opens pages, refuses unsafe links and asks for the create form', async () => {
    const host = mockHost();
    await mount(CARDS.links, host);
    await click(byTestId('app-button-stats'));
    expect(host.openPage).toHaveBeenCalledWith('stats');
    await click(byTestId('app-button-bad'));
    expect(mocks.openCardUrl).not.toHaveBeenCalled();
    await click(byTestId('app-button-quick'));
    expect(host.openCreate).toHaveBeenCalledWith(CARDS.links, 'quick');
  });
});

describe('shared states', () => {
  it('shows a card broken by a schema change as unavailable — the reason only to managers', async () => {
    const issues = [{ pageId: 'apply', cardId: 'mine', message: 'Field 9 was deleted' }];
    await mount(CARDS.mine, mockHost({ view: runtimeView({ issues }) }), recordsResult());
    expect(container.textContent).toContain('Card unavailable');
    expect(container.textContent).not.toContain('Field 9 was deleted');
    expect(container.textContent).not.toContain('Laptop');

    act(() => root?.unmount());
    container.remove();
    const managerView = runtimeView({ issues, app: { ...runtimeView().app, canManage: true } });
    await mount(CARDS.mine, mockHost({ view: managerView }), { kind: 'unavailable', message: 'Field 9 was deleted' });
    expect(container.textContent).toContain('Field 9 was deleted');
  });

  it('says when the role cannot read the table, and offers a retry when the card failed', async () => {
    await mount(CARDS.board, mockHost(), { kind: 'no_access' });
    expect(container.textContent).toContain('Not available to you');

    act(() => root?.unmount());
    container.remove();
    const host = mockHost();
    await mount(CARDS.mine, host, undefined, 'boom');
    expect(container.textContent).toContain('This card did not load');
    await click(buttonNamed('Retry'));
    expect(host.retry).toHaveBeenCalledWith(CARDS.mine);
  });
});
