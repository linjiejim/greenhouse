/**
 * "Needs you" card logic (./decision.ts): every kind's buttons and copy, the
 * receipts, refusal copy and the countdown. Root vitest — pure TS, no React Native.
 */

import { describe, expect, it } from 'vitest';
import type { BotRequestErrorCode, BotRequestPayload, BotRequestView } from '../../shared/bots';
import {
  CARD_ICON,
  COUNTDOWN_WINDOW_MS,
  alwaysSite,
  askAgainOffered,
  buttonLabel,
  cardButtons,
  cardKind,
  cardSubject,
  cardTitle,
  countdown,
  countdownNextChange,
  decisionErrorKey,
  decisionFor,
  detailRows,
  detailStacked,
  cardGist,
  diffCounts,
  hostOf,
  refusalCopy,
  settledReceipt,
  statusBadge,
} from './decision';

const T0 = Date.parse('2026-10-08T10:00:00.000Z');

function req(
  kind: BotRequestView['kind'],
  payload: BotRequestPayload | Record<string, unknown>,
  over: Partial<BotRequestView> = {},
): BotRequestView {
  return {
    id: 'r1',
    session_id: 's1',
    bot_id: 'bot_a',
    kind,
    status: 'pending',
    payload: payload as BotRequestPayload,
    result: null,
    expires_at: null,
    created_at: new Date(T0).toISOString(),
    ...over,
  };
}

const approval = (allowAlways = false, over: Partial<BotRequestView> = {}) =>
  req(
    'approval',
    {
      action: allowAlways ? 'vault_fill' : 'tool_call',
      title: 'Send the weekly report',
      details: [
        { label: 'Site', value: 'https://mail.example.com' },
        { label: 'to', value: 'team@example.com' },
      ],
      allow_always: allowAlways,
    },
    over,
  );
const task = (over: Partial<BotRequestView> = {}) =>
  req('task_start', { title: 'Tidy the meeting notes', brief: '**Do** it' }, over);
const create = (over: Partial<BotRequestView> = {}) =>
  req(
    'bot_create',
    { name: 'Curly', role: 'Writer', instructions: 'Write.', avatar: {}, template_key: 'writer' },
    over,
  );
const instructions = (over: Partial<BotRequestView> = {}) =>
  req('instructions_update', { instructions: 'a\nb\nc', reason: 'Clearer', current: 'a\nold' }, over);
const login = (kind: 'login' | 'otp' = 'login', over: Partial<BotRequestView> = {}) =>
  req(
    'login',
    { reason: 'Sign in', kind, origin: 'https://github.com', url: 'https://github.com/login', vault_matches: [] },
    over,
  );
const handback = (reason: 'interrupted' | 'waiting' = 'interrupted', over: Partial<BotRequestView> = {}) =>
  req('takeover', { implicit: true, reason, host: 'docs.example.com', title: 'Doc' }, over);
const captcha = (over: Partial<BotRequestView> = {}) =>
  req('takeover', { reason: 'A captcha', kind: 'captcha', url: 'https://shop.example.com/check' }, over);
const other = (over: Partial<BotRequestView> = {}) =>
  req('takeover', { reason: 'Pick the file', kind: 'other', url: 'https://drive.example.com/x' }, over);

const ids = (r: BotRequestView) => cardButtons(r).map((b) => `${b.id}${b.prominent ? '*' : ''}${b.confirm ? '?' : ''}`);

describe('cardKind', () => {
  it('splits take-overs three ways and keeps unknown kinds visible', () => {
    expect(cardKind(handback())).toBe('handback');
    expect(cardKind(captcha())).toBe('captcha');
    expect(cardKind(other())).toBe('takeover');
    // An implicit card that also says captcha is the computer's own — hand back, never "skip".
    expect(cardKind(req('takeover', { implicit: true, kind: 'captcha', reason: 'waiting' }))).toBe('handback');
    expect(cardKind(req('mystery' as BotRequestView['kind'], {}))).toBe('unknown');
    for (const kind of ['approval', 'task_start', 'bot_create', 'instructions_update', 'login'] as const) {
      expect(cardKind(req(kind, {}))).toBe(kind);
    }
    expect(Object.keys(CARD_ICON).sort()).toEqual([
      'approval',
      'bot_create',
      'captcha',
      'handback',
      'instructions_update',
      'login',
      'takeover',
      'task_start',
      'unknown',
    ]);
  });
});

describe('cardButtons (the honest mapping, D11)', () => {
  it('maps every kind × payload variant', () => {
    expect(ids(approval(false))).toEqual(['deny', 'approve*']);
    expect(ids(approval(true))).toEqual(['deny', 'always?', 'approve*']);
    expect(ids(task())).toEqual(['deny', 'approve*']);
    expect(ids(create())).toEqual(['deny', 'edit', 'approve*']);
    expect(ids(instructions())).toEqual(['deny', 'approve*']);
    expect(ids(login('login'))).toEqual(['deny', 'signIn*']);
    expect(ids(login('otp'))).toEqual(['deny', 'signIn*']);
    expect(ids(handback('interrupted'))).toEqual(['approve*']);
    expect(ids(handback('waiting'))).toEqual(['approve*']);
    // A human check cannot be passed from the phone: only skip.
    expect(ids(captcha())).toEqual(['deny']);
    // approve = "done, hand back" on the server: skip, or confirm it was done on the web.
    expect(ids(other())).toEqual(['deny', 'finished?']);
    expect(ids(req('mystery' as BotRequestView['kind'], {}))).toEqual([]);
  });

  it('offers nothing once settled, and at most one prominent button', () => {
    for (const status of ['resolved', 'denied', 'expired', 'canceled'] as const) {
      expect(cardButtons(approval(true, { status }))).toEqual([]);
    }
    for (const r of [approval(true), task(), create(), instructions(), login(), handback(), captcha(), other()]) {
      expect(cardButtons(r).filter((b) => b.prominent).length).toBeLessThanOrEqual(1);
    }
  });

  it('posts the decision each button names; edit / sign in open a sheet instead', () => {
    expect(decisionFor('approve')).toEqual({ decision: 'approve' });
    expect(decisionFor('finished')).toEqual({ decision: 'approve' });
    expect(decisionFor('always')).toEqual({ decision: 'always' });
    expect(decisionFor('deny')).toEqual({ decision: 'deny' });
    expect(decisionFor('edit')).toBeNull();
    expect(decisionFor('signIn')).toBeNull();
  });

  it('labels buttons by kind', () => {
    expect(buttonLabel(approval(), 'approve').key).toBe('bots.card.allowOnce');
    expect(buttonLabel(approval(), 'deny').key).toBe('bots.card.deny');
    expect(buttonLabel(task(), 'approve').key).toBe('bots.card.start');
    expect(buttonLabel(task(), 'deny').key).toBe('bots.card.cancel');
    expect(buttonLabel(create(), 'deny').key).toBe('bots.card.notNow');
    expect(buttonLabel(create(), 'edit').key).toBe('bots.card.editFirst');
    expect(buttonLabel(create(), 'approve').key).toBe('bots.card.create');
    expect(buttonLabel(instructions(), 'approve').key).toBe('bots.card.accept');
    expect(buttonLabel(instructions(), 'deny').key).toBe('bots.card.decline');
    expect(buttonLabel(login(), 'deny').key).toBe('bots.card.loginNotNow');
    expect(buttonLabel(login(), 'signIn').key).toBe('bots.card.signIn');
    expect(buttonLabel(handback(), 'approve')).toEqual({ key: 'bots.card.handBack' });
    expect(buttonLabel(captcha(), 'deny').key).toBe('bots.card.skip');
    expect(buttonLabel(other(), 'deny').key).toBe('bots.card.skip');
    expect(buttonLabel(other(), 'finished').key).toBe('bots.card.finished');
    expect(buttonLabel(approval(true), 'always').key).toBe('bots.card.allowAlways');
  });
});

describe('titles and subjects', () => {
  it('names the Bot and what the card is about', () => {
    expect(cardTitle(approval(), 'Pip')).toEqual({ key: 'bots.card.approvalTitle', vars: { name: 'Pip' } });
    // the site is the card's lock row, not the headline (it would wrap)
    expect(cardTitle(login('login'), 'Pip')).toEqual({ key: 'bots.card.loginTitle', vars: { name: 'Pip' } });
    expect(cardTitle(login('otp'), 'Pip').key).toBe('bots.card.otpTitle');
    expect(cardTitle(handback('interrupted'), 'Pip').key).toBe('bots.card.handBackTitle');
    expect(cardTitle(handback('waiting'), 'Pip').key).toBe('bots.card.waitingComputer');
    expect(cardTitle(captcha(), 'Pip').key).toBe('bots.card.captchaTitle');
    expect(cardTitle(other(), 'Pip').key).toBe('bots.card.otherTitle');
    expect(cardTitle(req('mystery' as BotRequestView['kind'], {}), 'Pip').key).toBe('bots.card.unknownTitle');
    expect(cardSubject(approval())).toBe('Send the weekly report');
    expect(cardSubject(task())).toBe('Tidy the meeting notes');
    expect(cardSubject(create())).toBe('Curly');
    expect(cardSubject(instructions())).toBeNull();
    expect(cardSubject(captcha())).toBe('shop.example.com');
    expect(cardSubject(handback())).toBe('docs.example.com');
  });

  it('reads hosts from origins, urls and bare hosts', () => {
    expect(hostOf('https://User@GitHub.com:443/login?x=1')).toBe('github.com');
    expect(hostOf('github.com/login')).toBe('github.com');
    expect(hostOf('  ')).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(
      alwaysSite({
        details: [
          { label: 'Login', value: 'Work' },
          { label: 'Site', value: 'https://a.example.com' },
        ],
      }),
    ).toBe('a.example.com');
    expect(alwaysSite({ details: [{ label: 'Login', value: 'Work' }] })).toBeNull();
  });
});

describe('status badge and receipts', () => {
  it('follows the web’s settled labels (settledLabelKey)', () => {
    expect(statusBadge(approval())).toEqual({ key: 'bots.card.waiting', tone: 'orange' });
    expect(statusBadge(approval(false, { status: 'resolved', result: { decision: 'approve' } })).key).toBe(
      'bots.card.allowed',
    );
    expect(statusBadge(approval(true, { status: 'resolved', result: { decision: 'always' } })).key).toBe(
      'bots.card.allowedAlways',
    );
    expect(statusBadge(handback(undefined, { status: 'resolved' })).key).toBe('bots.card.handedBack');
    expect(statusBadge(create({ status: 'resolved' })).key).toBe('bots.card.createdShort');
    expect(statusBadge(task({ status: 'resolved' })).key).toBe('bots.card.started');
    expect(statusBadge(instructions({ status: 'resolved' }))).toEqual({ key: 'bots.card.done', tone: 'green' });
    expect(statusBadge(login(undefined, { status: 'resolved' })).key).toBe('bots.card.done');
    expect(statusBadge(task({ status: 'denied' }))).toEqual({ key: 'bots.card.declined', tone: 'red' });
    expect(statusBadge(task({ status: 'expired' }))).toEqual({ key: 'bots.card.expired', tone: 'neutral' });
    expect(statusBadge(task({ status: 'canceled' }))).toEqual({ key: 'bots.card.canceled', tone: 'neutral' });
  });

  it('collapses a settled card to one line', () => {
    expect(settledReceipt(approval(false, { status: 'resolved', result: { decision: 'approve' } }))).toEqual({
      key: 'bots.card.receipt.allowed',
      vars: { title: 'Send the weekly report' },
    });
    expect(settledReceipt(approval(true, { status: 'resolved', result: { decision: 'always' } })).key).toBe(
      'bots.card.receipt.allowedAlways',
    );
    expect(settledReceipt(approval(false, { status: 'denied' }))).toEqual({
      key: 'bots.card.receipt.declinedTitle',
      vars: { title: 'Send the weekly report' },
    });
    expect(settledReceipt(instructions({ status: 'denied' }))).toEqual({ key: 'bots.card.receipt.declined' });
    expect(settledReceipt(task({ status: 'resolved' }))).toEqual({
      key: 'bots.card.receipt.started',
      vars: { title: 'Tidy the meeting notes' },
    });
    expect(settledReceipt(task({ status: 'expired' })).key).toBe('bots.card.receipt.expiredTitle');
    expect(settledReceipt(task({ status: 'canceled' })).key).toBe('bots.card.receipt.canceledTitle');
    expect(settledReceipt(instructions({ status: 'resolved' })).key).toBe('bots.card.receipt.instructions');
    expect(settledReceipt(login(undefined, { status: 'resolved' }))).toEqual({
      key: 'bots.card.receipt.signedInHost',
      vars: { host: 'github.com' },
    });
    expect(settledReceipt(login(undefined, { status: 'denied' })).key).toBe('bots.card.receipt.skippedHost');
    expect(settledReceipt(captcha({ status: 'denied' })).key).toBe('bots.card.receipt.skippedHost');
    expect(settledReceipt(other({ status: 'resolved' })).key).toBe('bots.card.receipt.handedBack');
    expect(settledReceipt(handback(undefined, { status: 'resolved' })).key).toBe('bots.card.receipt.handedBack');
  });

  it('names the Bot a proposal made — renamed in the form — else the proposal', () => {
    const made = create({ status: 'resolved', result: { decision: 'approve', bot_id: 'bot_new' } });
    expect(settledReceipt(made, (id) => (id === 'bot_new' ? 'Quill' : undefined))).toEqual({
      key: 'bots.card.created',
      vars: { bot: 'Quill' },
    });
    expect(settledReceipt(made)).toEqual({ key: 'bots.card.created', vars: { bot: 'Curly' } });
  });

  it('offers "Ask Again" only on expired re-askable cards with a Bot to ask', () => {
    expect(askAgainOffered(approval(false, { status: 'expired' }))).toBe(true);
    expect(askAgainOffered(task({ status: 'expired' }))).toBe(true);
    expect(askAgainOffered(create({ status: 'expired' }))).toBe(true);
    expect(askAgainOffered(instructions({ status: 'expired' }))).toBe(true);
    expect(askAgainOffered(login(undefined, { status: 'expired' }))).toBe(false);
    expect(askAgainOffered(other({ status: 'expired' }))).toBe(false);
    expect(askAgainOffered(task({ status: 'denied' }))).toBe(false);
    expect(askAgainOffered(task({ status: 'expired', bot_id: null }))).toBe(false);
  });
});

describe('refusals', () => {
  const codes: BotRequestErrorCode[] = [
    'page_gone',
    'origin_mismatch',
    'no_fields',
    'failed',
    'invalid',
    'limit',
    'computer_restarted',
    'bot_gone',
  ];

  it('gives every refusal code its own sentence', () => {
    const keys = codes.map((code) => decisionErrorKey(code, 409));
    expect(keys).toEqual(codes.map((code) => `bots.card.err.${code}`));
    expect(decisionErrorKey(null, 0)).toBe('bots.card.err.network');
    expect(decisionErrorKey('limit', 0)).toBe('bots.card.err.network');
    expect(decisionErrorKey(null, 503)).toBe('bots.card.err.unavailable');
    expect(decisionErrorKey(null, 400)).toBe('bots.card.err.failed');
    expect(decisionErrorKey('mystery' as BotRequestErrorCode, 409)).toBe('bots.card.err.failed');
  });

  it('falls back to the server’s own sentence for codes it does not know', () => {
    expect(refusalCopy({ status: 409, code: 'limit', message: 'Too many' })).toEqual({ key: 'bots.card.err.limit' });
    expect(refusalCopy({ status: 400, code: null, message: ' name is required ' })).toEqual({
      text: 'name is required',
    });
    expect(refusalCopy({ status: 400, code: 'bot_limit', message: '' })).toEqual({ key: 'bots.card.err.failed' });
    expect(refusalCopy({ status: 0, code: null, message: 'Network request failed' })).toEqual({
      key: 'bots.card.err.network',
    });
    expect(refusalCopy({ status: 503, code: null, message: 'vault down' })).toEqual({
      key: 'bots.card.err.unavailable',
    });
  });
});

describe('countdown', () => {
  const card = (expiresInMs: number | null) =>
    approval(false, {
      created_at: new Date(T0).toISOString(),
      expires_at: expiresInMs === null ? null : new Date(T0 + expiresInMs).toISOString(),
    });

  it('shows only in the last minute, from expires_at', () => {
    const r = card(110_000);
    expect(countdown(r, T0)).toEqual({ show: false, seconds: 110 });
    expect(countdown(r, T0 + 110_000 - COUNTDOWN_WINDOW_MS - 1)).toEqual({ show: false, seconds: 61 });
    expect(countdown(r, T0 + 110_000 - COUNTDOWN_WINDOW_MS)).toEqual({ show: true, seconds: 60 });
    expect(countdown(r, T0 + 109_500)).toEqual({ show: true, seconds: 1 });
    // At zero it says "expiring now" until the server flips the status.
    expect(countdown(r, T0 + 200_000)).toEqual({ show: true, seconds: 0 });
  });

  it('clamps to the card’s own life when the device clock runs behind', () => {
    const r = card(110_000);
    // Five minutes behind: expires_at − now is 410 s, but the card never had more than 110 s.
    expect(countdown(r, T0 - 300_000)).toEqual({ show: false, seconds: 110 });
    const short = card(30_000);
    expect(countdown(short, T0 - 300_000)).toEqual({ show: true, seconds: 30 });
  });

  it('never shows without an expiry or once settled', () => {
    expect(countdown(card(null), T0)).toEqual({ show: false, seconds: 0 });
    expect(countdown({ ...card(10_000), status: 'resolved' }, T0)).toEqual({ show: false, seconds: 0 });
    expect(countdown({ ...card(10_000), expires_at: 'not a date' }, T0)).toEqual({ show: false, seconds: 0 });
  });

  it('schedules the next tick: the window opening, then each second, then never', () => {
    const r = card(110_000);
    expect(countdownNextChange(r, T0)).toBe(50_000);
    expect(countdownNextChange(r, T0 + 50_000)).toBe(1_000);
    expect(countdownNextChange(r, T0 + 50_400)).toBe(600);
    expect(countdownNextChange(r, T0 + 110_000)).toBeNull();
    expect(countdownNextChange(card(null), T0)).toBeNull();
    // Behind by five minutes: wait until the raw remaining time reaches the window.
    expect(countdownNextChange(r, T0 - 300_000)).toBe(350_000);
  });
});

describe('details and diffs', () => {
  it('takes the server’s truncation markers out of the values', () => {
    const parsed = detailRows([
      { label: 'to', value: 'team@example.com' },
      { label: 'body', value: 'Hello there…(+120 more characters)' },
      { label: '…', value: '+2 more fields' },
    ]);
    expect(parsed.rows).toEqual([
      { label: 'to', value: 'team@example.com', moreChars: null },
      { label: 'body', value: 'Hello there', moreChars: 120 },
    ]);
    expect(parsed.hiddenFields).toBe(2);
    expect(detailRows([{ label: '…', value: '+1 more field' }]).hiddenFields).toBe(1);
    expect(detailRows(null)).toEqual({ rows: [], hiddenFields: null });
  });

  it('puts a long, multi-line or cut value under its label, across the row', () => {
    const [short] = detailRows([{ label: 'a', value: 'create' }]).rows;
    expect(detailStacked(short)).toBe(false);
    expect(detailStacked(detailRows([{ label: 'a', value: 'x…(+3 more characters)' }]).rows[0])).toBe(true);
    expect(detailStacked(detailRows([{ label: 'a', value: 'one\ntwo' }]).rows[0])).toBe(true);
    expect(detailStacked(detailRows([{ label: 'a', value: 'x'.repeat(41) }]).rows[0])).toBe(true);
  });

  it('says what a card is about in two short lines (cardGist)', () => {
    const approval = {
      kind: 'approval' as const,
      payload: {
        action: 'tool_call',
        title: 'Change your automations?',
        summary: 'change your automations',
        details: [
          { label: 'Action', value: 'Create' },
          { label: 'Name', value: 'Weekly due tasks' },
          { label: 'Task prompt', value: 'Collect every task due this week…(+400 more characters)' },
        ],
        allow_always: false,
      },
    } as unknown as Parameters<typeof cardGist>[0];
    expect(cardGist(approval)).toEqual({ what: 'Change your automations?', detail: 'Create · Weekly due tasks' });
    const proposal = {
      kind: 'bot_create' as const,
      payload: { name: 'Juniper', role: 'Researcher', instructions: 'Find sources.' },
    } as unknown as Parameters<typeof cardGist>[0];
    expect(cardGist(proposal)).toEqual({ what: 'Juniper · Researcher', detail: null });
    const task = {
      kind: 'task_start' as const,
      payload: { title: 'Tidy the notes', brief: '\n\nRead every note.\nThen merge.' },
    } as unknown as Parameters<typeof cardGist>[0];
    expect(cardGist(task)).toEqual({ what: 'Tidy the notes', detail: 'Read every note.' });
    const change = {
      kind: 'instructions_update' as const,
      payload: { reason: 'Be shorter', current: 'a', instructions: 'a\nb' },
    } as unknown as Parameters<typeof cardGist>[0];
    expect(cardGist(change)).toEqual({
      what: 'Be shorter',
      detail: { key: 'bots.card.diffSummary', vars: { added: '1', removed: '0' } },
    });
  });

  it('counts added and removed instruction lines', () => {
    expect(diffCounts({ current: 'a\nold', instructions: 'a\nb\nc' })).toEqual({ added: 2, removed: 1 });
    expect(diffCounts({ current: 'same', instructions: 'same' })).toEqual({ added: 0, removed: 0 });
  });
});
