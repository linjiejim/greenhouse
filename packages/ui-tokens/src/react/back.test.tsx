/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { EMBED_PROTOCOL } from '@greenhouse/types/plugins';
import { createEmbed, hashBack, useHostBack } from './embed.js';
import { Drawer } from './overlays.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let post: ReturnType<typeof vi.spyOn>;
beforeAll(() => {
  post = vi.spyOn(window.parent, 'postMessage');
  createEmbed();
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = '';
  post.mockClear();
});
function mount(node: React.ReactNode) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
}
const backState = () =>
  post.mock.calls
    .map(([m]) => m as { type: string; enabled?: boolean })
    .filter((m) => m.type === EMBED_PROTOCOL.back)
    .map((m) => m.enabled);
const hostBack = () =>
  act(
    () =>
      void window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: EMBED_PROTOCOL.backRequest },
          origin: window.location.origin,
          source: window.parent,
        }),
      ),
  );

function Detail({ drawer, onBack, onClose }: { drawer: boolean; onBack: () => void; onClose: () => void }) {
  useHostBack(onBack);
  return drawer ? (
    <Drawer title="Notes" onClose={onClose}>
      <p>notes</p>
    </Drawer>
  ) : null;
}

it('closes the open overlay first, then runs the view Back, and hands Back over at the top', () => {
  const onBack = vi.fn(),
    onClose = vi.fn();
  mount(<Detail drawer onBack={onBack} onClose={onClose} />);
  expect(backState()).toEqual([true]);
  hostBack();
  expect(onClose).toHaveBeenCalledOnce();
  expect(onBack).not.toHaveBeenCalled();
  act(() => root!.render(<Detail drawer={false} onBack={onBack} onClose={onClose} />));
  hostBack();
  expect(onBack).toHaveBeenCalledOnce();
  act(() => root!.unmount());
  root = null;
  expect(backState().at(-1)).toBe(false);
});

it('goes back to the view the page opened it from, else replaces with the parent', async () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const go = async (hash: string) => {
    window.location.hash = hash;
    await tick();
  };
  const back = vi.spyOn(window.history, 'back').mockImplementation(() => {});
  const replace = vi.spyOn(window.location, 'replace').mockImplementation((url) => {
    window.location.hash = String(url);
  });
  // opened straight on a sub-view (a deep link): Back goes up to the parent, leaving no entry
  await go('#/page/zh/a1');
  createEmbed();
  hashBack('#/');
  expect(replace).toHaveBeenCalledWith('#/');
  expect(back).not.toHaveBeenCalled();
  await tick();
  // opened from the list: Back returns to it through history, filters and scroll intact
  await go('#/page/zh/a2');
  hashBack('#/');
  expect(back).toHaveBeenCalledOnce();
  expect(replace).toHaveBeenCalledOnce();
});
