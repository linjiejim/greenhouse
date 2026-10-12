/**
 * Cold-start surface (./initial-surface.ts, spec 20261008 §2.2 / D3, 20261011 §3.1):
 * reopen the last Agent thread — else the main thread (Sprouty's DM) — only for a
 * bare home route, only with Agents on, once per process, and never over a deep
 * link. Root vitest.
 */

import { describe, expect, it } from 'vitest';
import { homeParams, type HomeParams } from '../nav';
import { initialSurface, type SurfaceInput } from './initial-surface';

/** Another Agent's DM, left open last time. */
const LAST = { c: 'sess_fern', title: 'Fern' };
/** The main thread: the member's DM with Sprouty. */
const MAIN = { c: 'sess_sprouty', title: 'Sprouty' };

function input(over: Partial<SurfaceInput> = {}): SurfaceInput {
  return {
    params: homeParams(),
    hydrated: true,
    gaveUp: false,
    last: LAST,
    main: MAIN,
    botsEnabled: true,
    restored: false,
    ...over,
  };
}

describe('initialSurface', () => {
  it('reopens the remembered thread for a bare home route with Agents on — over the main thread', () => {
    expect(initialSurface(input())).toEqual({ kind: 'thread', c: 'sess_fern', title: 'Fern' });
    expect(initialSurface(input({ main: null }))).toEqual({ kind: 'thread', c: 'sess_fern', title: 'Fern' });
  });

  it('opens the main thread when nothing is remembered', () => {
    expect(initialSurface(input({ last: null }))).toEqual({ kind: 'thread', c: 'sess_sprouty', title: 'Sprouty' });
    expect(initialSurface(input({ last: { c: '', title: 'x' } }))).toEqual({
      kind: 'thread',
      c: 'sess_sprouty',
      title: 'Sprouty',
    });
  });

  it.each<[string, Partial<HomeParams>]>([
    ['a chat', { id: 'sess_1' }],
    ['another thread', { c: 'sess_2' }],
    ['the widget compose link', { compose: '1' }],
    ['a card link', { request: 'brq_1' }],
    ['a new chat with an Agent', { profile: 'bot:b1' }],
    ['a placeholder title', { title: 'Notes' }],
    ['a read-only chat', { ro: '1' }],
  ])('leaves %s to the route', (_name, params) => {
    expect(initialSurface(input({ params: homeParams(params) }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ params: homeParams(params), last: null }))).toEqual({ kind: 'chat' });
  });

  it('waits for prefs before deciding — a remembered thread wins over the main thread', () => {
    expect(initialSurface(input({ hydrated: false, last: null }))).toEqual({ kind: 'wait' });
    expect(initialSurface(input({ hydrated: false, last: null, main: null }))).toEqual({ kind: 'wait' });
    // a route that names its surface, or Agents off, never waits
    expect(initialSurface(input({ hydrated: false, params: homeParams({ compose: '1' }) }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ hydrated: false, botsEnabled: false }))).toEqual({ kind: 'chat' });
  });

  it('waits for the main thread while nothing is remembered', () => {
    expect(initialSurface(input({ last: null, main: null }))).toEqual({ kind: 'wait' });
    expect(initialSurface(input({ last: null, main: { c: '', title: 'Sprouty' } }))).toEqual({ kind: 'wait' });
  });

  it('settles on a new chat once the wait gave up with the main thread still unknown', () => {
    expect(initialSurface(input({ last: null, main: null, gaveUp: true }))).toEqual({ kind: 'chat' });
    // prefs never read either: nothing remembered
    expect(initialSurface(input({ hydrated: false, gaveUp: true, last: null, main: null }))).toEqual({ kind: 'chat' });
  });

  it('opens the main thread once the wait gave up on unread prefs, when the main thread is known', () => {
    expect(initialSurface(input({ hydrated: false, gaveUp: true, last: null }))).toEqual({
      kind: 'thread',
      c: 'sess_sprouty',
      title: 'Sprouty',
    });
  });

  it('restores at most once per process', () => {
    expect(initialSurface(input({ restored: true }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ restored: true, last: null }))).toEqual({ kind: 'chat' });
  });

  it('never restores — nor opens the main thread — with Agents off', () => {
    expect(initialSurface(input({ botsEnabled: false }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ botsEnabled: false, last: null }))).toEqual({ kind: 'chat' });
  });

  it('never restores under a deep link stacked over home', () => {
    expect(initialSurface(input({ covered: true }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ covered: true, last: null }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ covered: false }))).toEqual({ kind: 'thread', c: 'sess_fern', title: 'Fern' });
  });

  it('never restores when a notification tap launched the app (the tap decides, even before prefs are read)', () => {
    expect(initialSurface(input({ launchedByPush: true }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ launchedByPush: true, last: null }))).toEqual({ kind: 'chat' });
    expect(initialSurface(input({ launchedByPush: true, hydrated: false }))).toEqual({ kind: 'chat' });
  });
});
