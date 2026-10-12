/**
 * The computer page's pure rules (./model.ts): paths as the member reads them,
 * the "in control" clock, and which card the page answers.
 */

import { describe, expect, it } from 'vitest';
import type { BotRequestView } from '../../shared/bots';
import { cardToAnswer, heldFor, homePath, needsKey, parentPath } from './model';

const req = (id: string, over: Partial<BotRequestView> = {}): BotRequestView => ({
  id,
  session_id: 's1',
  bot_id: 'b1',
  kind: 'takeover',
  status: 'pending',
  payload: { reason: 'x', kind: 'other' },
  result: null,
  expires_at: null,
  created_at: '2026-10-11T08:00:00.000Z',
  ...over,
});

describe('paths', () => {
  it('reads the home folder as ~ and stops going up there', () => {
    expect(homePath('/home/agent')).toBe('~');
    expect(homePath('/home/agent/work/report')).toBe('~/work/report');
    expect(homePath('/tmp')).toBe('/tmp');
    expect(parentPath('/home/agent/work/report')).toBe('/home/agent/work');
    expect(parentPath('/home/agent/work')).toBe('/home/agent');
    expect(parentPath('/home/agent')).toBeNull();
    expect(parentPath('/etc')).toBeNull();
  });
});

describe('heldFor', () => {
  it('counts mm:ss, then h:mm:ss, and never goes negative', () => {
    const since = '2026-10-11T08:00:00.000Z';
    const at = (s: number) => Date.parse(since) + s * 1000;
    expect(heldFor(since, at(0))).toBe('00:00');
    expect(heldFor(since, at(192))).toBe('03:12');
    expect(heldFor(since, at(3600 + 65))).toBe('1:01:05');
    expect(heldFor(since, at(-5))).toBe('00:00');
    expect(heldFor(null, at(100))).toBe('00:00');
  });
});

describe('cardToAnswer', () => {
  it('answers the card it was opened for while it is pending', () => {
    const asked = req('r2', { session_id: 's2' });
    expect(cardToAnswer([req('r1'), asked], { requestId: 'r2', sessionId: 's1' })).toBe(asked);
    expect(cardToAnswer([req('r1', { status: 'resolved' })], { requestId: 'r1', sessionId: 's1' })).toBeNull();
  });

  it('else the oldest pending computer card of its own conversation — never another one', () => {
    const older = req('old', { created_at: '2026-10-11T07:00:00.000Z' });
    const pending = [req('new'), older, req('other', { session_id: 's9' })];
    expect(cardToAnswer(pending, { sessionId: 's1' })).toBe(older);
    expect(cardToAnswer(pending, { sessionId: 's3' })).toBeNull();
    expect(cardToAnswer(pending, {})).toBeNull();
    // an approval is not answered at the computer
    expect(cardToAnswer([req('a', { kind: 'approval' })], { sessionId: 's1' })).toBeNull();
    // a sign-in is
    const login = req('l', { kind: 'login', payload: { reason: 'r', origin: 'https://x.example' } });
    expect(cardToAnswer([login], { sessionId: 's1' })).toBe(login);
  });

  it('one computer per Agent: only a card of the computer on screen (a guest Agent has its own)', () => {
    const guest = req('guest', { bot_id: 'b2', created_at: '2026-10-11T07:00:00.000Z' });
    const owner = req('owner', { bot_id: 'b1' });
    const onB1 = (r: { bot_id: string | null }) => r.bot_id === 'b1';
    expect(cardToAnswer([guest, owner], { sessionId: 's1', onComputer: onB1 })).toBe(owner);
    expect(cardToAnswer([guest], { sessionId: 's1', onComputer: onB1 })).toBeNull();
    // the card the page was opened for is that card's computer already
    expect(cardToAnswer([guest], { requestId: 'guest', sessionId: 's1', onComputer: onB1 })).toBe(guest);
  });
});

describe('needsKey', () => {
  it('names what the member is asked to do', () => {
    expect(needsKey(req('c', { payload: { reason: 'r', kind: 'captcha', url: 'https://x.example' } }))).toBe(
      'bots.computer.needsCaptcha',
    );
    expect(needsKey(req('t'))).toBe('bots.computer.needsTakeover');
    expect(needsKey(req('l', { kind: 'login', payload: { reason: 'r', origin: 'https://x.example' } }))).toBe(
      'bots.computer.needsLogin',
    );
    // raised by the computer itself (the member holds it): a hand back, not a check
    expect(needsKey(req('i', { payload: { implicit: true, reason: 'waiting', kind: 'captcha' } }))).toBe(
      'bots.computer.needsTakeover',
    );
  });
});
