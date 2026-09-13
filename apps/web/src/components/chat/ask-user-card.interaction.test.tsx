/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AskUserCard, type AskUserData } from './ask-user-card';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function mount(data: AskUserData, onSubmit: (message: string) => void) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(createElement(AskUserCard, { data, onSubmit })));
}

async function choose(value: string) {
  const radio = container!.querySelector(`input[type="radio"][value="${value}"]`) as HTMLInputElement;
  expect(radio).toBeTruthy();
  await act(async () => radio.click());
}

async function submit() {
  const button = [...container!.querySelectorAll('button')].find((b) => b.textContent?.includes('Submit'));
  expect(button).toBeTruthy();
  await act(async () => button!.click());
}

function confirmCard(options: Array<{ value: string; label: string }>): AskUserData {
  return {
    type: 'ask_user',
    status: 'pending',
    title: 'Send this email?',
    questions: [{ id: 'confirm', label: 'Send from jim@example.com?', type: 'single_choice', options, required: true }],
  };
}

describe('AskUserCard choice submission', () => {
  it('posts the machine-readable option value alongside the label', async () => {
    // email_mutation's confirm card carries the draft token in the option VALUE
    // ("send WWBLE2"). Posting only the label ("Send") strips the token; the
    // model then re-drafts and produces a second, never-answered confirm card
    // (dev regression, 2026-08-12).
    const onSubmit = vi.fn();
    await mount(
      confirmCard([
        { value: 'send WWBLE2', label: 'Send' },
        { value: 'cancel', label: 'Cancel' },
      ]),
      onSubmit,
    );

    await choose('send WWBLE2');
    await submit();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toContain('**1. Send from jim@example.com?**: Send (send WWBLE2)');
  });

  it('keeps the bare label when the value only restates it', async () => {
    const onSubmit = vi.fn();
    await mount(
      confirmCard([
        { value: 'send TOKEN', label: 'Send' },
        { value: 'cancel', label: 'Cancel' },
      ]),
      onSubmit,
    );

    await choose('cancel');
    await submit();

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toContain('**1. Send from jim@example.com?**: Cancel');
    expect(onSubmit.mock.calls[0][0]).not.toContain('Cancel (cancel)');
  });
});
