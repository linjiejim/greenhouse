/**
 * The Bots sheets' door (./route-gate-model.ts): closed gates go home — with
 * an alert on iOS, quietly on Android — and a signed-out or still-loading
 * member is left to the root layout. Root vitest.
 */

import { describe, expect, it } from 'vitest';
import { botsGateShows, botsRouteGate, bounceOnce } from './route-gate-model';

const ios = { auth: 'signed-in', platformReady: true } as const;
const android = { auth: 'signed-in', platformReady: false, threadsOn: false, identityOn: false } as const;

describe('botsRouteGate', () => {
  it('opens a conversation sheet only with the Bots conversations on', () => {
    expect(botsRouteGate({ ...ios, kind: 'threads', threadsOn: true, identityOn: true })).toBe('open');
    // Bots switched off, refused (403) or an external account: home, and say why
    expect(botsRouteGate({ ...ios, kind: 'threads', threadsOn: false, identityOn: true })).toBe('home-alert');
    expect(botsRouteGate({ ...ios, kind: 'threads', threadsOn: false, identityOn: false })).toBe('home-alert');
  });

  it('opens a Bot identity sheet on the identity gate alone', () => {
    // an internal account with the conversations switched off still manages its Bots (06 C6)
    expect(botsRouteGate({ ...ios, kind: 'identity', threadsOn: false, identityOn: true })).toBe('open');
    expect(botsRouteGate({ ...ios, kind: 'identity', threadsOn: false, identityOn: false })).toBe('home-alert');
  });

  it('sends every Android deep link home without a word', () => {
    expect(botsRouteGate({ ...android, kind: 'threads' })).toBe('home');
    expect(botsRouteGate({ ...android, kind: 'identity' })).toBe('home');
  });

  it('leaves a signed-out member to the auth gate', () => {
    expect(botsRouteGate({ ...ios, auth: 'signed-out', kind: 'threads', threadsOn: false, identityOn: false })).toBe(
      'wait',
    );
    expect(botsRouteGate({ ...android, auth: 'signed-out', kind: 'identity' })).toBe('wait');
  });

  it('waits out a loading account instead of bouncing (the gates read closed meanwhile)', () => {
    // startup or a station switch: no "Bots aren't available" for a member who has them
    expect(botsRouteGate({ ...ios, auth: 'loading', kind: 'threads', threadsOn: false, identityOn: false })).toBe(
      'wait',
    );
    expect(botsRouteGate({ ...ios, auth: 'loading', kind: 'identity', threadsOn: false, identityOn: false })).toBe(
      'wait',
    );
  });
});

describe('bounceOnce', () => {
  it('lets the first of a burst through and the next one after the window', () => {
    const bounce = bounceOnce(1000);
    expect(bounce(5000)).toBe(true);
    // a second stacked sheet closing in the same moment
    expect(bounce(5000)).toBe(false);
    expect(bounce(5999)).toBe(false);
    expect(bounce(6000)).toBe(true);
  });

  it('keeps separate doors independent', () => {
    const a = bounceOnce(1000);
    const b = bounceOnce(1000);
    expect(a(0)).toBe(true);
    expect(b(0)).toBe(true);
  });
});

describe('botsGateShows', () => {
  it('shows an open gate at once, whether or not it was open before', () => {
    expect(botsGateShows({ open: true, wasOpen: false, latched: false })).toBe(true);
    expect(botsGateShows({ open: true, wasOpen: false, latched: true })).toBe(true);
  });

  it('never shows a sheet reached with its gate closed', () => {
    expect(botsGateShows({ open: false, wasOpen: false, latched: false })).toBe(false);
    expect(botsGateShows({ open: false, wasOpen: false, latched: true })).toBe(false);
  });

  it('keeps a latched sheet that was up when its gate closed (until the navigation removes it)', () => {
    expect(botsGateShows({ open: false, wasOpen: true, latched: true })).toBe(true);
    expect(botsGateShows({ open: false, wasOpen: true, latched: false })).toBe(false);
  });
});
