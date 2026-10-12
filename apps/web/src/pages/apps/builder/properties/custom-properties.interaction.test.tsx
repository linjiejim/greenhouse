/** @vitest-environment happy-dom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppCard } from '@greenhouse/types/apps';
import { I18nProvider } from '../../../../lib/i18n';
import { useAuthStore } from '../../../../stores';
import { REQUESTS, schemaFixture } from '../test-fixtures';
import { CustomProperties } from './custom-properties';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const card: Extract<AppCard, { kind: 'custom' }> = {
  id: 'custom',
  kind: 'custom',
  layout: { x: 0, y: 0, w: 12, h: 6 },
  html: '<p>Tickets</p>',
  bindings: [{ id: 'rows', kind: 'records', source: { tableId: REQUESTS }, fieldIds: [1] }],
  create: { bindingId: 'rows', fieldIds: [1] },
};
let root: Root;
let container: HTMLDivElement;
const onChange = vi.fn();
const previousUser = useAuthStore.getState().currentUser;

beforeEach(async () => {
  onChange.mockClear();
  useAuthStore.setState({ currentUser: { id: 'editor', role: 'super', nickname: 'Editor' } as never });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider initialLocale="en">
        <CustomProperties card={card} schema={schemaFixture()} onChange={onChange} />
      </I18nProvider>,
    );
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  useAuthStore.setState({ currentUser: previousUser });
});

async function apply(settings: unknown) {
  const input = container.querySelector<HTMLTextAreaElement>('[data-testid="app-custom-settings"]')!;
  if (!input.closest('details')!.open) {
    await act(async () => input.closest('details')!.querySelector('summary')!.click());
  }
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, JSON.stringify(settings));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    container.querySelector<HTMLButtonElement>('[data-testid="app-custom-settings-apply"]')!.click();
  });
}

it('keeps the execution limit visible while code and optional bindings stay editable', async () => {
  const notice = container.querySelector('[data-testid="app-custom-execution-notice"]')!;
  expect(notice.textContent).toContain('cannot run yet');
  expect(notice.closest('details')).toBeNull();
  const code = container.querySelector<HTMLTextAreaElement>('[data-testid="app-custom-code"]')!;
  const settings = container.querySelector<HTMLTextAreaElement>('[data-testid="app-custom-settings"]')!;
  expect(code.disabled).toBe(false);
  expect(settings.closest('details')!.open).toBe(false);
  await apply({ bindings: card.bindings, actions: [] });
  expect(settings.closest('details')!.open).toBe(true);
  expect(onChange).toHaveBeenCalledOnce();
});

it.each([
  { bindings: [null] },
  { bindings: [{ ...card.bindings[0], source: null }] },
  { bindings: card.bindings, actions: [null] },
  { bindings: card.bindings, actions: [{ id: 'approve', bindingId: 'rows', do: null }] },
  { bindings: card.bindings, create: null },
])('keeps malformed setting objects out of the local draft: %j', async (settings) => {
  await apply(settings);
  expect(onChange).not.toHaveBeenCalled();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();

  // Correcting the JSON applies it and clears the error; omitted create is removed.
  await apply({ bindings: card.bindings, actions: [] });
  expect(onChange).toHaveBeenCalledOnce();
  expect(onChange).toHaveBeenCalledWith({
    id: card.id,
    kind: card.kind,
    layout: card.layout,
    html: card.html,
    bindings: card.bindings,
    actions: [],
  });
  expect(container.querySelector('[role="alert"]')).toBeNull();
});
