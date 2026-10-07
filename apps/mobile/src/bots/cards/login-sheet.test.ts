/**
 * The sign-in sheet's selection rule (./login-sheet.ts): only a sign-in card
 * gets the form, and the form outlives its own decision. Root vitest — pure TS.
 */

import { describe, expect, it } from 'vitest';
import type { BotRequestPayload, BotRequestView } from '../../shared/bots';
import { isLoginCard, loginSheetRequest } from './login-sheet';

function req(
  kind: BotRequestView['kind'],
  payload: BotRequestPayload | Record<string, unknown>,
  over: Partial<BotRequestView> = {},
): BotRequestView {
  return {
    id: 'r1',
    session_id: 's1',
    bot_id: 'b1',
    kind,
    status: 'pending',
    payload: payload as BotRequestPayload,
    result: null,
    expires_at: null,
    created_at: '2026-10-08T10:00:00.000Z',
    ...over,
  };
}

const LOGIN = { reason: 'Sign in', kind: 'login', origin: 'https://github.com', url: null, vault_matches: [] };
const OTP = { ...LOGIN, kind: 'otp' };
const ready = (request: BotRequestView) => ({ state: 'ready' as const, request });

describe('isLoginCard', () => {
  it('is a login request with a login or code payload', () => {
    expect(isLoginCard(req('login', LOGIN))).toBe(true);
    expect(isLoginCard(req('login', OTP))).toBe(true);
  });

  it('is nothing else', () => {
    expect(isLoginCard(req('login', { ...LOGIN, kind: 'passkey' }))).toBe(false);
    expect(isLoginCard(req('login', {}))).toBe(false);
    expect(isLoginCard(req('approval', { action: 'tool_call', title: 'x', details: [], allow_always: false }))).toBe(
      false,
    );
    // A non-login card whose payload happens to say `kind: 'login'`.
    expect(isLoginCard(req('takeover', { ...LOGIN }))).toBe(false);
    expect(isLoginCard(req('bot_create', LOGIN))).toBe(false);
    expect(isLoginCard(req('task_start', LOGIN))).toBe(false);
  });
});

describe('loginSheetRequest', () => {
  it('shows the form for a pending sign-in card', () => {
    const r = req('login', LOGIN);
    expect(loginSheetRequest(ready(r), null)).toBe(r);
    expect(loginSheetRequest(ready(req('login', OTP)), null)?.id).toBe('r1');
  });

  it('reads a pending card of another kind as gone', () => {
    for (const kind of ['approval', 'bot_create', 'task_start', 'takeover', 'instructions_update'] as const) {
      expect(loginSheetRequest(ready(req(kind, {})), null)).toBeNull();
    }
  });

  it('reads a settled card as gone unless this sheet decided it', () => {
    const settled = req('login', LOGIN, { status: 'resolved' });
    expect(loginSheetRequest(ready(settled), null)).toBeNull();
    expect(loginSheetRequest(ready(settled), req('login', LOGIN))).toBe(settled);
  });

  it('keeps the held card while the lists drop it', () => {
    const held = req('login', LOGIN);
    expect(loginSheetRequest({ state: 'missing', request: null }, held)).toBe(held);
    expect(loginSheetRequest({ state: 'loading', request: null }, held)).toBe(held);
  });

  it('never holds another card or a non-login card', () => {
    const other = req('login', LOGIN, { id: 'r2' });
    expect(loginSheetRequest(ready(req('login', LOGIN, { status: 'resolved' })), other)).toBeNull();
    expect(loginSheetRequest({ state: 'missing', request: null }, req('approval', {}))).toBeNull();
  });

  it('shows nothing while loading, missing or failed', () => {
    expect(loginSheetRequest({ state: 'loading', request: null }, null)).toBeNull();
    expect(loginSheetRequest({ state: 'missing', request: null }, null)).toBeNull();
    expect(loginSheetRequest({ state: 'error', request: null }, null)).toBeNull();
  });
});
