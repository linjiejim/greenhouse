/** @vitest-environment happy-dom */

/**
 * The form page (`#/forms/:id`) under real interaction: it renders the submit
 * view from `/api/forms` only (never the Tables directory), fills fields
 * through the shared FieldEditor, uploads an attachment through the form and
 * submits its id, and shows the one-submission states.
 */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableFormSubmitView } from '@greenhouse/types/tables';
import { I18nProvider } from '../../lib/i18n';
import { TablesRequestError } from '../../lib/api/tables';
import { TablesFormPage } from './form-page';

const api = vi.hoisted(() => ({
  openTableForm: vi.fn(),
  submitTableForm: vi.fn(),
  uploadTableFormFile: vi.fn(),
  listTableUsers: vi.fn(),
}));
vi.mock('../../lib/api/tables', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/tables')>()),
  ...api,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const view: TableFormSubmitView = {
  id: 4,
  name: 'Expenses',
  title: 'Expense claim',
  description: 'Claim what you spent.',
  submitLabel: 'Send claim',
  successMessage: 'Claim received.',
  fields: [
    { id: 1, name: 'Item', type: 'text', required: true },
    { id: 2, name: 'Approver', type: 'user', required: false },
    { id: 3, name: 'Receipt', type: 'attachment', required: false },
  ],
  userOptions: [{ id: 'u9', name: 'Mia', email: 'mia@example.com' }],
  alreadySubmitted: false,
  allowMultiple: false,
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function flush() {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <TablesFormPage formId={4} />
      </I18nProvider>,
    );
  });
  await flush();
}

async function type(element: HTMLInputElement | HTMLSelectElement, value: string) {
  await act(async () => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

beforeEach(() => {
  api.openTableForm.mockResolvedValue(view);
  api.uploadTableFormFile.mockResolvedValue({ id: 31, name: 'taxi.pdf', size: 2048 });
  api.submitTableForm.mockResolvedValue({ submitted: true, successMessage: 'Claim received.' });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('TablesFormPage', () => {
  it('fills, uploads and submits through /api/forms only', async () => {
    await mount();
    expect(api.openTableForm).toHaveBeenCalledWith(4);
    expect(api.listTableUsers).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Expense claim');
    expect(container.textContent).toContain('Claim what you spent.');

    const inputs = container.querySelectorAll('input:not([type="file"])');
    await type(inputs[0] as HTMLInputElement, 'Taxi');
    const approver = container.querySelector('select') as HTMLSelectElement;
    expect([...approver.options].map((option) => option.textContent)).toContain('Mia · mia@example.com');
    await type(approver, 'u9');

    const file = new File(['receipt'], 'taxi.pdf', { type: 'application/pdf' });
    const picker = container.querySelector('input[type="file"]') as HTMLInputElement;
    Object.defineProperty(picker, 'files', { value: [file], configurable: true });
    await act(async () => {
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(api.uploadTableFormFile).toHaveBeenCalledWith(4, file);
    expect(container.textContent).toContain('taxi.pdf');

    await act(async () => button('Send claim').click());
    await flush();
    expect(api.submitTableForm).toHaveBeenCalledTimes(1);
    expect(api.submitTableForm).toHaveBeenCalledWith(4, { '1': 'Taxi', '2': 'u9', '3': [31] });
    expect(container.textContent).toContain('Claim received.');
    // A single-submit form offers no second go.
    expect(container.textContent).not.toContain('Submit another response');
  });

  it('shows the already-submitted state instead of the fields', async () => {
    api.openTableForm.mockResolvedValue({ ...view, alreadySubmitted: true });
    await mount();
    expect(container.textContent).toContain('You have already responded');
    expect(container.querySelector('input')).toBeNull();
  });

  it('turns a lost double-submit race into the already-submitted state', async () => {
    api.submitTableForm.mockRejectedValue(
      new TablesRequestError('already_submitted', 409, { reason: 'already_submitted' }),
    );
    await mount();
    await type(container.querySelector('input') as HTMLInputElement, 'Taxi');
    await act(async () => button('Send claim').click());
    await flush();
    expect(container.textContent).toContain('You have already responded');
  });

  it('tells an audience member the form is not published yet', async () => {
    api.openTableForm.mockRejectedValue(
      new TablesRequestError('Form is not published', 404, { reason: 'not_published' }),
    );
    await mount();
    expect(container.textContent).toContain('Form is not published');
  });
});
