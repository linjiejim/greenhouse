import { describe, expect, it, vi } from 'vitest';
import { homeParams, openAppRoute, openConversation, openNewChat, type AppRouter } from './nav';

function fakeRouter() {
  return {
    replace: vi.fn(),
    dismissTo: vi.fn(),
    push: vi.fn(),
  };
}
const as = (router: ReturnType<typeof fakeRouter>) => router as unknown as AppRouter;

describe('going home (apps/mobile/AGENTS.md: dismissTo merges params)', () => {
  it('always sets all five home params, so nothing of the previous conversation stays', () => {
    expect(homeParams({ c: 'conv-1' })).toEqual({ c: 'conv-1', agent: '', title: '', compose: '', request: '' });
    const router = fakeRouter();
    openConversation(as(router), { id: 'conv-1', request: 'req_1' }, 'dismissTo');
    expect(router.dismissTo).toHaveBeenCalledWith({
      pathname: '/',
      params: { c: 'conv-1', agent: '', title: '', compose: '', request: 'req_1' },
    });
    openNewChat(as(router), { agent: 'sage', compose: true });
    expect(router.replace).toHaveBeenCalledWith({
      pathname: '/',
      params: { c: 'new', agent: 'sage', title: '', compose: '1', request: '' },
    });
  });
});

describe('openAppRoute', () => {
  it('opens the app’s places and says no for web-only ones', () => {
    const router = fakeRouter();
    expect(openAppRoute(as(router), { kind: 'run', id: 'run-9' })).toBe(true);
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/runs/[id]', params: { id: 'run-9' } });
    expect(openAppRoute(as(router), { kind: 'agent', id: 'ag_1' })).toBe(true);
    expect(router.push).toHaveBeenLastCalledWith({ pathname: '/agents/[id]', params: { id: 'ag_1' } });
    expect(openAppRoute(as(router), { kind: 'conversation', id: 'conv-1' }, { request: 'req_1' })).toBe(true);
    expect(router.dismissTo).toHaveBeenLastCalledWith({
      pathname: '/',
      params: { c: 'conv-1', agent: '', title: '', compose: '', request: 'req_1' },
    });
    expect(openAppRoute(as(router), { kind: 'main' })).toBe(true);
    expect(router.dismissTo).toHaveBeenLastCalledWith({
      pathname: '/',
      params: { c: '', agent: '', title: '', compose: '', request: '' },
    });
    expect(openAppRoute(as(router), { kind: 'web', path: '/knowledge/doc-1' })).toBe(false);
  });
});
