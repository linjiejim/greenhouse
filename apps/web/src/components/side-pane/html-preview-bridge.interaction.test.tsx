/**
 * @vitest-environment happy-dom
 *
 * The html-preview reply channel (`window.greenhouse.sendPrompt`) fills the
 * composer only when the member just interacted with the page, only from this
 * preview's own frame, and only says so when a composer actually took the text.
 */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../lib/i18n';
import { onComposerDraft, type ComposerDraft } from '../../lib/composer-draft';
import { HTML_BRIDGE } from '@greenhouse/types/rich-output';

const toast = vi.fn();
vi.mock('../ui', async (importOriginal) => ({ ...(await importOriginal<typeof import('../ui')>()), toast }));

const { HtmlPreview, hasTransientActivation } = await import('./html-preview');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;
let stopListening: (() => void) | null = null;

function setActivation(isActive: boolean | undefined) {
  Object.defineProperty(navigator, 'userActivation', {
    configurable: true,
    value: isActive === undefined ? undefined : { isActive, hasBeenActive: isActive },
  });
}

async function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(I18nProvider, {
        initialLocale: 'en',
        children: createElement(HtmlPreview, { code: '<p>Quote</p>', title: 'Quote', bridge: true }),
      }),
    );
  });
  const frame = container.querySelector('iframe');
  if (!frame?.contentWindow) throw new Error('preview frame missing');
  return frame.contentWindow;
}

async function post(source: MessageEventSource | null, text = '3 × ¥4,200') {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { data: { type: HTML_BRIDGE.messageType, text }, source }));
    vi.advanceTimersByTime(HTML_BRIDGE.throttleMs);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  toast.mockClear();
});

afterEach(async () => {
  stopListening?.();
  stopListening = null;
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  setActivation(undefined);
  vi.useRealTimers();
});

describe('html-preview reply channel', () => {
  it('fills the composer after a gesture in the page, and says so', async () => {
    const drafts: ComposerDraft[] = [];
    stopListening = onComposerDraft((draft) => void drafts.push(draft));
    setActivation(true);
    const frame = await mount();

    await post(frame);

    expect(drafts).toEqual([{ text: '3 × ¥4,200', images: [], append: true, fromPage: true }]);
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('ignores a call made without a gesture (on load, on a timer)', async () => {
    const drafts: ComposerDraft[] = [];
    stopListening = onComposerDraft((draft) => void drafts.push(draft));
    setActivation(false);
    const frame = await mount();

    await post(frame);

    expect(drafts).toEqual([]);
    expect(toast).not.toHaveBeenCalled();
  });

  it('ignores messages from any window but the preview frame', async () => {
    const drafts: ComposerDraft[] = [];
    stopListening = onComposerDraft((draft) => void drafts.push(draft));
    setActivation(true);
    await mount();

    await post(window);

    expect(drafts).toEqual([]);
  });

  it('stays quiet when no composer takes the text (a viewer who cannot write)', async () => {
    stopListening = onComposerDraft((draft) => (draft.fromPage ? false : undefined));
    setActivation(true);
    const frame = await mount();

    await post(frame);

    expect(toast).not.toHaveBeenCalled();
  });
});

describe('hasTransientActivation', () => {
  it('follows navigator.userActivation, and allows browsers without it', () => {
    expect(hasTransientActivation({ userActivation: { isActive: true } } as unknown as Navigator)).toBe(true);
    expect(hasTransientActivation({ userActivation: { isActive: false } } as unknown as Navigator)).toBe(false);
    expect(hasTransientActivation({} as Navigator)).toBe(true);
  });
});
