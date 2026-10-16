/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { it, expect, vi } from 'vitest';
import { usePlantWorkState } from './use-plant-work';
import type { PlantWork } from './plant-work';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
it('does not replay history or allow a completion timer to overwrite newer work', () => {
  vi.useFakeTimers();
  const host = document.createElement('div');
  const root = createRoot(host);
  function Probe({ work }: { work: PlantWork }) {
    return createElement('span', null, usePlantWorkState(work));
  }
  const render = (work: PlantWork) => act(() => root.render(createElement(Probe, { work })));
  try {
    render({});
    expect(host.textContent).toBe('idle');
    render({ streaming: true, hasText: true });
    expect(host.textContent).toBe('speaking');
    render({});
    expect(host.textContent).toBe('done');
    act(() => vi.advanceTimersByTime(900));
    render({ working: true });
    expect(host.textContent).toBe('thinking');
    act(() => vi.advanceTimersByTime(1000));
    expect(host.textContent).toBe('thinking');
    render({ failed: true });
    expect(host.textContent).toBe('error');
    render({ working: true });
    render({ waiting: true });
    expect(host.textContent).toBe('waiting');
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
  }
});
