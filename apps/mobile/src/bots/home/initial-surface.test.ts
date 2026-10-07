/**
 * Cold-start restore (./initial-surface.ts, spec §2.2 / D3): reopen the last
 * Bots thread only for a bare home route, only with Bots on, once per process,
 * and never over a deep link. Root vitest.
 */

import { describe, expect, it } from 'vitest';
import { homeParams, type HomeParams } from '../nav';
import { initialSurface, type SurfaceInput } from './initial-surface';

const LAST = { c: 'sess_sprouty', title: 'Sprouty' };

function input(over: Partial<SurfaceInput> = {}): SurfaceInput {
  return { params: homeParams(), hydrated: true, last: LAST, botsEnabled: true, restored: false, ...over };
}

describe('initialSurface', () => {
  it('reopens the remembered thread for a bare home route with Bots on', () => {
    expect(initialSurface(input())).toEqual({ kind: 'thread', c: 'sess_sprouty', title: 'Sprouty' });
  });

  it('is a new chat when nothing is remembered', () => {
    expect(initialSurface(input({ last: null }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ last: { c: '', title: 'x' } }))).toEqual({ kind: 'chat' });
  });

  it.each<[string, Partial<HomeParams>]>([
    ['a chat', { id: 'sess_1' }],
    ['another thread', { c: 'sess_2' }],
    ['the widget compose link', { compose: '1' }],
    ['a card link', { request: 'brq_1' }],
    ['a new chat with a Bot', { profile: 'bot:b1' }],
    ['a placeholder title', { title: 'Notes' }],
    ['a read-only chat', { ro: '1' }],
  ])('leaves %s to the route', (_name, params) => {
    expect(initialSurface(input({ params: homeParams(params) }))).toEqual({ kind: 'chat' });
  });

  it('waits for prefs before deciding — but only when there is something to restore', () => {
    expect(initialSurface(input({ hydrated: false, last: null }))).toEqual({ kind: 'wait' });
    // a route that names its surface, or Bots off, never waits
    expect(initialSurface(input({ hydrated: false, params: homeParams({ compose: '1' }) }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ hydrated: false, botsEnabled: false }))).toEqual({ kind: 'chat' });
  });

  it('settles on a new chat once the wait gave up (hydrated, nothing read)', () => {
    expect(initialSurface(input({ hydrated: true, last: null }))).toEqual({ kind: 'chat' });
  });

  it('restores at most once per process', () => {
    expect(initialSurface(input({ restored: true }))).toEqual({ kind: 'chat' });
  });

  it('never restores with Bots off', () => {
    expect(initialSurface(input({ botsEnabled: false }))).toEqual({ kind: 'chat' });
  });

  it('never restores under a deep link stacked over home', () => {
    expect(initialSurface(input({ covered: true }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ covered: false }))).toEqual({ kind: 'thread', c: 'sess_sprouty', title: 'Sprouty' });
  });
});
