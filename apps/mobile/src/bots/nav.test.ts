/**
 * Home navigation (./nav.ts): every route to `/` carries all seven params, because `dismissTo`
 * merges params into the existing home route. Root vitest; the router is a fake.
 */

import { describe, expect, it, vi } from 'vitest';
import { homeParams, openChat, openNewChat, openThread, type AppRouter, homeNavCount, onHomeNav } from './nav';

const KEYS = ['c', 'compose', 'id', 'profile', 'request', 'ro', 'title'];

function fakeRouter() {
  const replace = vi.fn();
  const dismissTo = vi.fn();
  return { router: { replace, dismissTo } as unknown as AppRouter, replace, dismissTo };
}

describe('homeParams', () => {
  it('fills all seven keys, clearing what is not given', () => {
    expect(homeParams()).toEqual({ id: '', c: '', title: '', ro: '0', compose: '', request: '', profile: '' });
    const params = homeParams({ c: 's1', title: 'Sprouty' });
    expect(Object.keys(params).sort()).toEqual(KEYS);
    expect(params).toEqual({ id: '', c: 's1', title: 'Sprouty', ro: '0', compose: '', request: '', profile: '' });
  });
});

describe('open*', () => {
  it('openThread replaces inside the drawer, and carries request / compose', () => {
    const { router, replace, dismissTo } = fakeRouter();
    openThread(router, { c: 's1', title: 'Fern', request: 'brq_1', compose: true });
    expect(dismissTo).not.toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith({
      pathname: '/',
      params: { id: '', c: 's1', title: 'Fern', ro: '0', compose: '1', request: 'brq_1', profile: '' },
    });
  });

  it('dismissTo from sheets and links, with every key set', () => {
    const { router, replace, dismissTo } = fakeRouter();
    openThread(router, { c: 's2' }, 'dismissTo');
    openChat(router, { id: 'chat_1', title: 'Notes', ro: true }, 'dismissTo');
    openNewChat(router, { profile: 'bot:bot_a', compose: true }, 'dismissTo');
    expect(replace).not.toHaveBeenCalled();
    const sent = dismissTo.mock.calls.map(([href]) => href.params);
    for (const params of sent) expect(Object.keys(params).sort()).toEqual(KEYS);
    expect(sent).toEqual([
      { id: '', c: 's2', title: '', ro: '0', compose: '', request: '', profile: '' },
      { id: 'chat_1', c: '', title: 'Notes', ro: '1', compose: '', request: '', profile: '' },
      { id: '', c: '', title: '', ro: '0', compose: '1', request: '', profile: 'bot:bot_a' },
    ]);
  });

  it('a plain new chat clears everything', () => {
    const { router, replace } = fakeRouter();
    openNewChat(router);
    expect(replace).toHaveBeenCalledWith({ pathname: '/', params: homeParams() });
  });
});

describe('home navigation signal', () => {
  it('counts every navigation to home, even to the params it already has', () => {
    const { router } = fakeRouter();
    const seen: number[] = [];
    const off = onHomeNav(() => seen.push(homeNavCount()));
    const before = homeNavCount();
    openNewChat(router);
    openNewChat(router); // identical params: the router would swallow it, the signal does not
    openThread(router, { c: 's1' }, 'dismissTo');
    off();
    openNewChat(router);
    expect(seen).toEqual([before + 1, before + 2, before + 3]);
    expect(homeNavCount()).toBe(before + 4);
  });
});
