/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalHash, useHashRouter } from './hash-router';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe('canonicalHash', () => {
  it('resolves retired hashes to the page that replaced them, query tabs included', () => {
    expect(canonicalHash('')).toBe('#/home');
    expect(canonicalHash('#/agents')).toBe('#/automations?tab=profiles');
    expect(canonicalHash('#/tasks')).toBe('#/skillhub?tab=prompts');
    expect(canonicalHash('#/chat?view=agents')).toBe('#/automations?tab=profiles');
    expect(canonicalHash('#/executions')).toBe('#/activity');
    expect(canonicalHash('#/workbench')).toBe('#/home');
    expect(canonicalHash('#/skillhub?tab=prompts')).toBe('#/skillhub?tab=prompts');
    expect(canonicalHash('#/wiki/a?x=1', new Map([['wiki', 'content/pages']]))).toBe('#/content/pages/a?x=1');
    // A core route is never aliased away.
    expect(canonicalHash('#/files', new Map([['files', 'elsewhere']]))).toBe('#/files');
  });

  it('makes Home the new-conversation screen; #/chat only opens an existing conversation', () => {
    expect(canonicalHash('#/chat')).toBe('#/home');
    expect(canonicalHash('#/chat?new=123')).toBe('#/home?new=123');
    expect(canonicalHash('#/chat?session=abc')).toBe('#/chat?session=abc');
    expect(canonicalHash('#/inbox')).toBe('#/home');
    expect(canonicalHash('#/home?new=5')).toBe('#/home?new=5');
  });
});

describe('useHashRouter', () => {
  it('renders where a retired hash lands, and replaces it in the address bar instead of stacking history', async () => {
    window.location.hash = '#/skillhub?tab=prompts';
    const seen: string[] = [];
    function Probe() {
      const { hash } = useHashRouter();
      seen.push(hash);
      return createElement('span', { 'data-hash': hash });
    }
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Probe)));
    expect(container.querySelector('span')?.dataset.hash).toBe('#/skillhub?tab=prompts');

    const before = window.history.length;
    await act(async () => {
      window.location.hash = '#/agents';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(container.querySelector('span')?.dataset.hash).toBe('#/automations?tab=profiles');
    expect(window.location.hash).toBe('#/automations?tab=profiles');
    // `#/agents` never renders, and the redirect does not add a history entry of its own.
    expect(seen).not.toContain('#/agents');
    expect(window.history.length).toBeLessThanOrEqual(before + 1);
  });
});
