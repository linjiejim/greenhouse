/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmBlock } from './confirm-block';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

const data = {
  type: 'confirm' as const,
  text: 'Proceed?',
  actions: [
    { label: 'Yes', value: 'yes', variant: 'primary' as const },
    { label: 'No', value: 'no' },
  ],
};

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

describe('ConfirmBlock delivery failure', () => {
  it('re-arms its buttons when the choice was not delivered', async () => {
    let reject: (err: Error) => void = () => {};
    const onAction = vi.fn(
      () =>
        new Promise<void>((_resolve, rejectSend) => {
          reject = rejectSend;
        }),
    );
    const container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(ConfirmBlock, { data, onAction })));

    await act(async () => button('Yes').click());
    expect(onAction).toHaveBeenCalledWith('yes');
    expect(button('No').disabled).toBe(true);

    await act(async () => reject(new Error('offline')));
    expect(button('No').disabled).toBe(false);
    await act(async () => button('Yes').click());
    expect(onAction).toHaveBeenCalledTimes(2);
  });
});
