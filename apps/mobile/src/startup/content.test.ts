import { describe, expect, it, vi } from 'vitest';
import { StartupContent, waitsForHome } from './content';

describe('StartupContent', () => {
  it('starts pending and publishes only readiness changes', () => {
    const content = new StartupContent();
    const listener = vi.fn();
    const unsubscribe = content.subscribe(listener);
    const owner = {};
    expect(content.getSnapshot()).toBe(false);
    content.report(owner, false);
    expect(listener).not.toHaveBeenCalled();
    content.report(owner, true);
    content.report(owner, true);
    expect(content.getSnapshot()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    content.report(owner, false);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('forgets readiness when the owning screen leaves', () => {
    const content = new StartupContent();
    const cleanup = content.report({}, true);
    expect(content.getSnapshot()).toBe(true);
    cleanup();
    expect(content.getSnapshot()).toBe(false);
  });

  it('a late forwarder cleanup cannot clear its replacement', () => {
    const content = new StartupContent();
    const leaveForwarder = content.report({}, false);
    const leaveThread = content.report({}, true);
    leaveForwarder();
    expect(content.getSnapshot()).toBe(true);
    leaveThread();
    expect(content.getSnapshot()).toBe(false);
  });

  it('a newly focused pending screen replaces stale home readiness', () => {
    const content = new StartupContent();
    const leaveHome = content.report({}, true);
    const thread = {};
    content.report(thread, false);
    expect(content.getSnapshot()).toBe(false);
    leaveHome();
    content.report(thread, true);
    expect(content.getSnapshot()).toBe(true);
  });
});

describe('waitsForHome', () => {
  it.each([
    [],
    ['(drawer)'],
    ['(drawer)', '(main)'],
    ['(drawer)', '(main)', 'index'],
    ['chat', '[id]'],
    ['bots'],
    ['bots', 'index'],
  ])('waits for the actual home surface or its forwarder: %j', (...segments) => {
    expect(waitsForHome(segments)).toBe(true);
  });

  it.each([
    ['login'],
    ['knowledge', '[slug]'],
    ['projects', '[id]'],
    ['settings', 'bots'],
    ['sheets', 'stations'],
    ['peek', 'doc', '[slug]'],
    ['bots', 'request'],
    ['bots', 'needs-you'],
  ])('does not wait for home underneath another deep link: %j', (...segments) => {
    expect(waitsForHome(segments)).toBe(false);
  });
});
