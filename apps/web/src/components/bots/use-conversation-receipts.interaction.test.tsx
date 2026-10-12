/** @vitest-environment happy-dom */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotMessage } from '@greenhouse/types/bots';
import { useConversationReceipts } from './use-conversation-receipts';

const api = vi.hoisted(() => ({ getConversationReceipts: vi.fn(), markConversationRead: vi.fn() }));
vi.mock('../../lib/api/bots', () => api);
vi.mock('../../lib/ws', () => ({
  wsClient: { onEvent: () => () => {}, onStatusChange: () => () => {} },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const messages = [1, 2].map((seq) => ({ id: `m${seq}`, seq }) as BotMessage);
let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;
let visible = true;
let ends: number[];

function Probe() {
  const scroll = useRef<HTMLDivElement>(null);
  useConversationReceipts('room', true, messages, scroll);
  return (
    <div ref={scroll} data-scroll>
      {messages.map((m) => (
        <span key={m.id} data-receipt-end={m.id} />
      ))}
    </div>
  );
}
async function tick() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });
}
beforeEach(async () => {
  vi.useFakeTimers();
  visible = true;
  ends = [100, 700];
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => (visible ? 'visible' : 'hidden'));
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const i = messages.findIndex((m) => m.id === this.dataset.receiptEnd);
    return { top: i < 0 ? 0 : ends[i], bottom: i < 0 ? 500 : ends[i] } as DOMRect;
  });
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  api.getConversationReceipts.mockReset().mockResolvedValue({ people: [], agents: [] });
  api.markConversationRead.mockReset().mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('marks only visible message ends, and never advances while the page is hidden', async () => {
  await tick();
  expect(api.markConversationRead.mock.calls).toEqual([['room', 'm1']]);
  visible = false;
  ends = [-100, 200];
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  expect(api.markConversationRead).toHaveBeenCalledTimes(1);
  visible = true;
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  expect(api.markConversationRead.mock.calls).toEqual([
    ['room', 'm1'],
    ['room', 'm2'],
  ]);
  ends = [100, 700];
  container.querySelector('[data-scroll]')!.dispatchEvent(new Event('scroll'));
  await tick();
  expect(api.markConversationRead).toHaveBeenCalledTimes(2);
});

it('reports newly visible messages after an earlier read request finishes', async () => {
  let finish!: () => void;
  api.markConversationRead.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await tick();
  ends = [-100, 200];
  container.querySelector('[data-scroll]')!.dispatchEvent(new Event('scroll'));
  await tick();
  expect(api.markConversationRead).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  await tick();
  expect(api.markConversationRead.mock.calls).toEqual([
    ['room', 'm1'],
    ['room', 'm2'],
  ]);
});
