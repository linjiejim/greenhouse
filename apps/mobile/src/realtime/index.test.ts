/**
 * The realtime socket's URL (./index.ts `socketUrl`): a token only ever goes to the origin of the
 * station it belongs to, and only while that is the active station. Runs in the ROOT vitest unit
 * project with the stores faked (no React Native module loads).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

let active: { id: string; baseUrl: string; name: string } | null = null;
let token: string | null = null;
let tokenStation: string | null = null;

vi.mock('../store/stations', () => ({ getActiveStation: () => active }));
vi.mock('../api/token-storage', () => ({
  getAccessToken: () => token,
  getTokenStationId: () => tokenStation,
}));
vi.mock('../api/client', () => ({ refreshTokens: async () => false }));
// ./index.ts builds the client with the global WebSocket at import (never opened here).
vi.hoisted(() => {
  const g = globalThis as { WebSocket?: unknown };
  g.WebSocket ??= class {};
});

import { socketUrl } from './index';

beforeEach(() => {
  active = { id: 'B', baseUrl: 'https://b.example', name: 'B' };
  token = 'tok-B';
  tokenStation = 'B';
});

describe('socketUrl', () => {
  it("pairs the active station's origin with its own token", () => {
    expect(socketUrl()).toBe('wss://b.example/api/ws?token=tok-B');
  });

  it('refuses a token the mirror holds for another station (a switch mid-flight)', () => {
    token = 'tok-A';
    tokenStation = 'A';
    expect(socketUrl()).toBeNull();
  });

  it('stays closed with no token or no active station', () => {
    token = null;
    expect(socketUrl()).toBeNull();
    token = 'tok-B';
    active = null;
    expect(socketUrl()).toBeNull();
  });
});
