/** @vitest-environment happy-dom */

/**
 * Request cards and memory receipts under real interaction: what the member
 * typed survives the live → persisted swap, a refused sign-in says why (and is
 * not "already handled"), and an undone memory stays undone.
 */

import { act, createElement, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotRequestView, BotView, ComputerStatusView } from '@greenhouse/types/bots';
import { I18nProvider } from '../../lib/i18n';
import { BotsApiError, type BotMessage } from '../../lib/api/bots';
import type { BotStreamSegment } from '../../lib/session-manager';
import { ToastContainer } from '../ui';
import { BotTranscript, type BotTranscriptProps } from './bot-transcript';
import { computerPhase } from './computer-phase';
import { MemoryReceipts, resetUndoneMemoriesForTest } from './memory-receipts';
import type { PendingSend } from './transcript';

const fakes = vi.hoisted(() => {
  class FakeRfb {
    static instances: FakeRfb[] = [];
    viewOnly = false;
    focusOnClick = true;
    scaleViewport = false;
    resizeSession = true;
    clipViewport = true;
    background = '';
    disconnected = false;
    constructor(
      public target: HTMLElement,
      public url: string,
    ) {
      FakeRfb.instances.push(this);
    }
    addEventListener() {}
    removeEventListener() {}
    disconnect() {
      this.disconnected = true;
    }
    sendKey() {}
    focus() {}
    blur() {}
  }
  return { FakeRfb };
});

const api = vi.hoisted(() => ({
  decideRequest: vi.fn(),
  deleteBotMemory: vi.fn(),
  archiveUserMemory: vi.fn(),
  listBots: vi.fn(),
  takeoverComputer: vi.fn(),
  createComputerViewToken: vi.fn(),
  computerViewerUrl: (token: string) => `ws://greenhouse.test/api/ws/computer?token=${token}`,
}));
vi.mock('../../lib/api/bots', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/api/bots')>()),
  ...api,
}));
vi.mock('../../lib/novnc/loader', () => ({ loadRfb: async () => fakes.FakeRfb }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SAGE: BotView = {
  id: 'bot_sage',
  name: 'Sage',
  role: 'Researcher',
  instructions: '',
  avatar: { color: 'ocean' },
  model_id: null,
  template_key: null,
  status: 'active',
  description: '',
  tools: null,
  max_steps: null,
  lifecycle_status: 'draft',
  lifecycle_note: null,
  is_shared: false,
  current_version: 1,
  published_version: null,
  next_review_at: null,
  forked_from: null,
  user_id: 'u1',
  updated_at: '2026-10-05T00:00:00.000Z',
  dm_session_id: 'dm-sage',
  last_active_at: null,
  created_at: '2026-10-05T00:00:00.000Z',
};

function request(partial: Partial<BotRequestView>): BotRequestView {
  return {
    id: 'brq_1',
    session_id: 'dm-sage',
    bot_id: SAGE.id,
    kind: 'login',
    status: 'pending',
    payload: {
      reason: 'Sign in to GitHub',
      kind: 'login',
      origin: 'https://github.com',
      url: 'https://github.com/login',
      vault_matches: [],
    },
    result: null,
    expires_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
    ...partial,
  };
}

function requestRow(req: BotRequestView, seq: number): BotMessage {
  return {
    id: `row-${seq}`,
    role: 'system',
    content: 'Sage needs you',
    bot_id: SAGE.id,
    bot_event: { kind: 'request', request_id: req.id, request_kind: req.kind, bot_id: SAGE.id },
    pipeline: [],
    references: [],
    reasoning: null,
    model: null,
    images: [],
    created_at: '2026-10-05T00:00:00.000Z',
    seq,
  };
}

let root: ReturnType<typeof createRoot> | null = null;

function props(overrides: Partial<BotTranscriptProps>): BotTranscriptProps {
  return {
    sessionId: 'dm-sage',
    kind: 'direct',
    title: 'Sage',
    ownerBotId: SAGE.id,
    members: [SAGE],
    lookup: (key) => (key === SAGE.id || key === SAGE.name ? SAGE : undefined),
    messages: [],
    hasMore: false,
    loadingEarlier: false,
    onLoadEarlier: vi.fn(),
    segments: [],
    liveRequests: [],
    pending: [],
    requests: new Map(),
    busy: false,
    runError: null,
    onDismissRunError: vi.fn(),
    vaultAvailable: false,
    onRequestSettled: vi.fn(),
    onStale: vi.fn(),
    onOpenComputer: vi.fn(),
    onViewSummary: vi.fn(),
    onAddress: vi.fn(),
    onSendText: vi.fn(async () => {}),
    onStarter: vi.fn(),
    ...overrides,
  };
}

function tree(element: ReactElement) {
  return createElement(I18nProvider, {
    initialLocale: 'en',
    children: createElement('div', null, element, createElement(ToastContainer)),
  });
}

async function mount(element: ReactElement) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(tree(element)));
  await flush();
}

async function rerender(element: ReactElement) {
  await act(async () => root?.render(tree(element)));
  await flush();
}

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function fill(input: HTMLInputElement | null, value: string) {
  if (!input) throw new Error(`Missing input in: ${document.body.textContent}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function inputs(): HTMLInputElement[] {
  return [...document.querySelectorAll<HTMLInputElement>('[data-testid="bots-request-card"] input')];
}

beforeEach(() => {
  for (const fn of Object.values(api)) if (vi.isMockFunction(fn)) fn.mockReset();
  api.createComputerViewToken.mockResolvedValue({ token: 'tok-1', expires_at: new Date().toISOString() });
  fakes.FakeRfb.instances.length = 0;
  resetUndoneMemoriesForTest();
});

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = '';
});

describe('request cards across the live → persisted swap', () => {
  it('keeps what the member typed when the persisted row replaces the live card', async () => {
    const req = request({});
    const segment: BotStreamSegment = {
      botId: SAGE.id,
      reason: 'user',
      status: 'streaming',
      text: 'I need you to sign in',
      reasoning: '',
      toolCalls: [],
    };
    const requests = new Map([[req.id, req]]);
    await mount(createElement(BotTranscript, props({ segments: [segment], liveRequests: [req], requests })));

    const [username] = inputs();
    await fill(username, 'mia@example.com');
    expect(inputs()[0].value).toBe('mia@example.com');

    // The run settles: the persisted row arrives and the live segment is gone.
    await rerender(createElement(BotTranscript, props({ messages: [requestRow(req, 3)], requests })));
    expect(document.querySelectorAll('[data-testid="bots-request-card"]')).toHaveLength(1);
    expect(inputs()[0].value).toBe('mia@example.com');
  });
});

describe('secure sign-in refusals', () => {
  async function submitSignIn(onStale = vi.fn()) {
    const req = request({});
    await mount(
      createElement(
        BotTranscript,
        props({ messages: [requestRow(req, 1)], requests: new Map([[req.id, req]]), onStale }),
      ),
    );
    const [username, password] = inputs();
    await fill(username, 'mia@example.com');
    await fill(password, 'hunter2');
    const form = document.querySelector('[data-testid="bots-request-card"] form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
    return { onStale };
  }

  it('says why a sign-in could not be filled and keeps the card open — not "already handled"', async () => {
    api.decideRequest.mockRejectedValueOnce(new BotsApiError('The sign-in page is no longer open', 409, 'page_gone'));
    const { onStale } = await submitSignIn();

    const text = document.body.textContent ?? '';
    expect(text).not.toContain('This request was already handled.');
    expect(text).toContain('The sign-in page is no longer open, so nothing was filled.');
    expect(onStale).not.toHaveBeenCalled();
    // Still pending, with a way forward; the secret was wiped on purpose.
    expect(text).toContain('Waiting for you');
    expect(document.querySelector('[data-testid="bots-login-refusal"]')?.textContent).toContain('Ask again');
    expect(inputs()[1].value).toBe('');
  });

  it("shows the server's message for a refusal code it does not know", async () => {
    api.decideRequest.mockRejectedValueOnce(new BotsApiError('The vault is locked for maintenance', 409, 'brand_new'));
    await submitSignIn();
    expect(document.body.textContent).toContain('The vault is locked for maintenance');
  });

  it('treats an already-decided request as stale and re-reads', async () => {
    api.decideRequest.mockRejectedValueOnce(new BotsApiError('already decided', 409, 'already_decided'));
    const { onStale } = await submitSignIn();
    expect(document.body.textContent).toContain('This request was already handled.');
    expect(onStale).toHaveBeenCalledTimes(1);
  });
});

describe('secure sign-in: what is sent', () => {
  async function mountLogin(req = request({}), extra: Partial<BotTranscriptProps> = {}) {
    await mount(
      createElement(
        BotTranscript,
        props({ messages: [requestRow(req, 1)], requests: new Map([[req.id, req]]), ...extra }),
      ),
    );
  }
  function signInButton(): HTMLButtonElement {
    return [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Sign in')!;
  }
  async function submit() {
    const form = document.querySelector('[data-testid="bots-request-card"] form')!;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flush();
  }

  it('sends a password on its own (the second card of a two-step sign-in), and only that', async () => {
    api.decideRequest.mockResolvedValueOnce({ request: request({ status: 'resolved' }) });
    await mountLogin(request({}), { vaultAvailable: true });
    expect(signInButton().disabled).toBe(true);

    await fill(inputs()[1], 'hunter2');
    expect(signInButton().disabled).toBe(false);
    await submit();
    expect(api.decideRequest).toHaveBeenCalledWith('brq_1', {
      decision: 'approve',
      login: { password: 'hunter2', submit: true },
    });
  });

  it('sends a user name on its own — the server follows the page to its password step', async () => {
    api.decideRequest.mockResolvedValueOnce({ request: request({ status: 'resolved' }) });
    await mountLogin();
    await fill(inputs()[0], '  mia@example.com ');
    await submit();
    expect(api.decideRequest).toHaveBeenCalledWith('brq_1', {
      decision: 'approve',
      login: { username: 'mia@example.com', submit: true },
    });
  });

  it('explains a computer restart and offers to ask the Bot again', async () => {
    api.decideRequest.mockRejectedValueOnce(new BotsApiError('restarted', 409, 'computer_restarted'));
    await mountLogin();
    await fill(inputs()[1], 'hunter2');
    await submit();

    const text = document.body.textContent ?? '';
    expect(text).toContain('The computer restarted and closed the sign-in page');
    expect(text).not.toContain('This request was already handled.');
    const refusal = document.querySelector('[data-testid="bots-login-refusal"]');
    expect(refusal?.textContent).toContain('Ask Sage to open the page again.');
    expect(refusal?.textContent).toContain('Ask again');
  });

  it('shows an expired sign-in as expired, with nothing to fill or click', async () => {
    await mountLogin(request({ status: 'expired' }));
    const card = document.querySelector('[data-testid="bots-request-card"]')!;
    expect(card.textContent).toContain('Expired');
    expect(card.textContent).toContain('This sign-in request expired — ask the Bot again');
    expect(card.querySelectorAll('input')).toHaveLength(0);
    expect(card.querySelectorAll('button:not([aria-expanded])').length).toBe(0);
  });
});

describe('take-over cards', () => {
  function takeover(partial: Partial<BotRequestView>): BotRequestView {
    return request({
      kind: 'takeover',
      payload: { reason: 'Solve the CAPTCHA', kind: 'captcha', url: 'https://example.com/login' },
      ...partial,
    });
  }
  async function mountCard(req: BotRequestView) {
    await mount(
      createElement(BotTranscript, props({ messages: [requestRow(req, 1)], requests: new Map([[req.id, req]]) })),
    );
  }

  it('says the member took over mid-action and hands back from the card', async () => {
    const req = takeover({
      payload: {
        implicit: true,
        reason: 'interrupted',
        host: 'example.com',
        title: 'Checkout',
      } as unknown as BotRequestView['payload'],
    });
    api.decideRequest.mockResolvedValueOnce({ request: { ...req, status: 'resolved' } });
    await mountCard(req);

    const card = document.querySelector('[data-testid="bots-request-card"]')!;
    expect(card.textContent).toContain('You took over while Sage was working');
    expect(card.textContent).toContain('Sage will pick up where it left off when you hand back.');
    expect(card.textContent).toContain('Checkout');
    // The payload's `reason` is a machine code — never shown as words.
    expect(card.textContent).not.toContain('interrupted');
    const handBack = [...card.querySelectorAll('button')].find(
      (b) => b.textContent === 'Hand back — let Sage continue',
    );
    await act(async () => handBack?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(api.decideRequest).toHaveBeenCalledWith(req.id, { decision: 'approve' });
  });

  it('says a Bot is waiting for the computer', async () => {
    await mountCard(
      takeover({ payload: { implicit: true, reason: 'waiting' } as unknown as BotRequestView['payload'] }),
    );
    expect(document.body.textContent).toContain('Sage is waiting to use the computer');
  });

  it('collapses an expired take-over to its receipt, with no actions', async () => {
    await mountCard(takeover({ status: 'expired' }));
    const card = document.querySelector('[data-testid="bots-request-card"]')!;
    expect(card.textContent).toContain('Expired');
    expect(card.textContent).not.toContain("I'm done");
    expect(card.textContent).not.toContain('Ask again');
  });
});

describe('approval details', () => {
  it('shows a long value whole and reads the server’s truncation markers as notes', async () => {
    const body = `Line one\nLine two ${'x'.repeat(300)}`;
    const req = request({
      kind: 'approval',
      payload: {
        action: 'tool_call',
        title: 'Send an email',
        details: [
          { label: 'body', value: `${body}…(+1200 more characters)` },
          { label: '…', value: '+2 more fields' },
        ],
        allow_always: false,
      },
    });
    await mount(
      createElement(BotTranscript, props({ messages: [requestRow(req, 1)], requests: new Map([[req.id, req]]) })),
    );
    const list = document.querySelector('[data-testid="bots-detail-list"]')!;
    const value = list.querySelector('dd')!;
    expect(value.textContent).toContain(body);
    expect(value.className).toContain('whitespace-pre-wrap');
    expect(value.className).not.toContain('truncate');
    expect(value.textContent).toContain('1200 more characters not shown');
    expect(value.textContent).not.toContain('(+1200');
    expect(list.textContent).toContain('2 more fields not shown');
    expect([...list.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['body']);
  });
});

describe('the "new Bot" card', () => {
  it('previews the proposed Bot still — in a transcript only the speaking Bot moves', async () => {
    const req = request({
      kind: 'bot_create',
      payload: { name: 'Fern', role: 'Writer', instructions: '', avatar: { plant: 'fern' }, template_key: null },
    });
    await mount(
      createElement(BotTranscript, props({ messages: [requestRow(req, 1)], requests: new Map([[req.id, req]]) })),
    );
    const card = document.querySelector('[data-testid="bots-request-card"][data-request-kind="bot_create"]')!;
    // The 80px preview is a hero, which idles by default; the card must hold it still.
    expect(card.querySelector('[data-testid="bots-avatar-picker"] > div > .pa-root > svg.pa-fern')).not.toBeNull();
    expect(card.querySelectorAll('.pa-mo')).toHaveLength(0);
  });
});

describe('a later line about a card', () => {
  it('renders "Sign-in skipped" as a system line under the one card', async () => {
    const req = request({ status: 'denied' });
    const skipped: BotMessage = {
      ...requestRow(req, 2),
      content: 'Sign-in to github.com skipped',
      created_at: '2026-10-05T00:00:20.000Z',
    };
    await mount(
      createElement(
        BotTranscript,
        props({ messages: [requestRow(req, 1), skipped], requests: new Map([[req.id, req]]) }),
      ),
    );
    expect(document.querySelectorAll('[data-testid="bots-request-card"]')).toHaveLength(1);
    const line = document.querySelector('[data-testid="bots-event"][data-event-kind="request"]');
    expect(line?.textContent).toBe('Sign-in to github.com skipped');
  });

  it('stays a system line when the card itself is on an older page', async () => {
    const req = request({ status: 'denied' });
    const skipped: BotMessage = {
      ...requestRow(req, 80),
      content: 'Sign-in to github.com skipped',
      created_at: '2026-10-05T03:00:00.000Z',
    };
    await mount(
      createElement(BotTranscript, props({ messages: [skipped], hasMore: true, requests: new Map([[req.id, req]]) })),
    );
    expect(document.querySelector('[data-testid="bots-request-card"]')).toBeNull();
    expect(document.querySelector('[data-testid="bots-event"]')?.textContent).toBe('Sign-in to github.com skipped');
  });
});

describe('memory receipts', () => {
  const receipt = { memoryId: 41, title: 'Prefers Python', scope: 'user' as const };

  it('stays undone when the receipt is rendered again (live → persisted, remount)', async () => {
    api.archiveUserMemory.mockResolvedValue(undefined);
    await mount(createElement(MemoryReceipts, { key: 'live', receipts: [receipt], botId: SAGE.id, botName: 'Sage' }));
    const undo = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Undo');
    await act(async () => undo?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(api.archiveUserMemory).toHaveBeenCalledWith(41);

    // A different instance — the persisted message's receipt.
    await rerender(
      createElement(MemoryReceipts, { key: 'persisted', receipts: [receipt], botId: SAGE.id, botName: 'Sage' }),
    );
    expect(document.body.textContent).toContain('Forgotten');
    expect([...document.querySelectorAll('button')].some((button) => button.textContent === 'Undo')).toBe(false);
  });

  it('reads as undone when the server says the memory no longer stands (after a reload)', async () => {
    await mount(
      createElement(MemoryReceipts, {
        receipts: [receipt],
        botId: SAGE.id,
        botName: 'Sage',
        memoryStates: { '41': 'archived' },
      }),
    );
    expect(document.body.textContent).toContain('Forgotten');
  });

  it('reads memory_states through a persisted turn: dormant still stands, deleted is undone', async () => {
    const turn: BotMessage = {
      id: 'm-7',
      role: 'assistant',
      content: 'Noted.',
      bot_id: SAGE.id,
      bot_event: null,
      pipeline: [
        {
          tool: 'memory',
          input: {},
          output: { action: 'remember', scope: 'user', remembered: { id: 51, title: 'Lives in Berlin' } },
        },
        {
          tool: 'memory',
          input: {},
          output: { action: 'remember', scope: 'bot', remembered: { id: 52, title: 'Prefers tables' } },
        },
      ] as unknown as BotMessage['pipeline'],
      references: [],
      reasoning: null,
      model: null,
      images: [],
      created_at: '2026-10-05T00:00:00.000Z',
      seq: 4,
    };
    await mount(
      createElement(BotTranscript, props({ messages: [turn], memoryStates: { '51': 'dormant', '52': 'deleted' } })),
    );
    const receipts = [...document.querySelectorAll('[data-testid="bots-memory-receipts"] > span')];
    expect(receipts).toHaveLength(2);
    expect(receipts[0].textContent).toContain('Remembered for all your Bots');
    expect(receipts[0].textContent).toContain('Undo');
    expect(receipts[1].textContent).toContain('Forgotten');
    expect(receipts[1].textContent).not.toContain('Undo');
  });

  it('takes a 404 as "already undone", without an error', async () => {
    api.deleteBotMemory.mockRejectedValueOnce(new BotsApiError('Memory not found', 404));
    await mount(
      createElement(MemoryReceipts, {
        receipts: [{ ...receipt, memoryId: 42, scope: 'bot' }],
        botId: SAGE.id,
        botName: 'Sage',
      }),
    );
    const undo = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Undo');
    await act(async () => undo?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(document.body.textContent).toContain('Forgotten');
    expect(document.body.textContent).not.toContain('Could not undo');
  });
});

describe('the human-check card', () => {
  function computerStatus(overrides: Partial<ComputerStatusView> = {}): ComputerStatusView {
    return {
      runtime: { state: 'ready', reason: null, hardened: true },
      state: 'running',
      state_reason: null,
      controller: 'bot',
      controller_since: null,
      last_active_at: null,
      queue_position: null,
      disk_bytes: null,
      timezone: null,
      lang: 'en-US',
      ...overrides,
    };
  }
  const IN_CONTROL = computerStatus({ controller: 'user', controller_since: new Date().toISOString() });

  const captcha = (partial: Partial<BotRequestView> = {}) =>
    request({
      id: 'brq_check',
      kind: 'takeover',
      payload: {
        reason: 'example.com asks for human verification — please complete it on the computer',
        kind: 'captcha',
        url: 'https://example.com/login',
      },
      ...partial,
    });

  /** What the Bots page does: one computer status the card reads and updates. */
  function Host({
    req,
    initial,
    onOpenComputer,
  }: {
    req: BotRequestView;
    initial: ComputerStatusView;
    onOpenComputer?: () => void;
  }) {
    const [status, setStatus] = useState(initial);
    return createElement(BotTranscript, {
      ...props({
        messages: [requestRow(req, 1)],
        requests: new Map([[req.id, req]]),
        onOpenComputer: onOpenComputer ?? vi.fn(),
      }),
      computer: { phase: computerPhase(status), apply: setStatus, refresh: vi.fn(async () => {}) },
    });
  }

  const card = () => document.querySelector('[data-testid="bots-request-card"]')!;
  const screen = () => card().querySelector('[data-testid="computer-screen"]');

  it('shows the live screen, view only, with the way to verify right there', async () => {
    await mount(createElement(Host, { req: captcha(), initial: computerStatus() }));
    expect(card().textContent).toContain('Sage needs you to complete a human check');
    expect(card().textContent).toContain('example.com asks for human verification');
    expect(card().textContent).toContain("When you're through, choose “I'm done” and Sage carries on.");
    expect(screen()?.getAttribute('data-view-only')).toBe('true');
    expect(fakes.FakeRfb.instances[0]?.viewOnly).toBe(true);
    expect(card().querySelector('[data-testid="bots-request-verify-here"]')).not.toBeNull();
  });

  it('takes the computer over in place: the embedded screen becomes interactive', async () => {
    api.takeoverComputer.mockResolvedValue(IN_CONTROL);
    await mount(createElement(Host, { req: captcha(), initial: computerStatus() }));

    await act(async () => {
      card()
        .querySelector('[data-testid="bots-request-verify-here"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(api.takeoverComputer).toHaveBeenCalledTimes(1);
    expect(screen()?.getAttribute('data-view-only')).toBe('false');
    expect(fakes.FakeRfb.instances.at(-1)?.viewOnly).toBe(false);
    // In control: no second "Verify here"; "I'm done" hands back for this card.
    expect(card().querySelector('[data-testid="bots-request-verify-here"]')).toBeNull();
    api.decideRequest.mockResolvedValueOnce({ request: captcha({ status: 'resolved' }) });
    const done = [...card().querySelectorAll('button')].find((button) => button.textContent === "I'm done");
    await act(async () => done?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();
    expect(api.decideRequest).toHaveBeenCalledWith('brq_check', { decision: 'approve' });
  });

  it('explains a refused take-over', async () => {
    api.takeoverComputer.mockRejectedValueOnce(new BotsApiError('busy', 503, 'busy'));
    await mount(createElement(Host, { req: captcha(), initial: computerStatus() }));
    await act(async () => {
      card()
        .querySelector('[data-testid="bots-request-verify-here"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(document.body.textContent).toContain('All computers are busy right now');
    expect(screen()?.getAttribute('data-view-only')).toBe('true');
  });

  it('skips (declines) and opens the computer', async () => {
    const onOpenComputer = vi.fn();
    api.decideRequest.mockResolvedValueOnce({ request: captcha({ status: 'denied' }) });
    await mount(createElement(Host, { req: captcha(), initial: computerStatus(), onOpenComputer }));

    await act(async () => {
      card()
        .querySelector('[data-testid="bots-request-open-computer"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onOpenComputer).toHaveBeenCalledTimes(1);

    await act(async () => {
      card()
        .querySelector('[data-testid="bots-request-skip"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    expect(api.decideRequest).toHaveBeenCalledWith('brq_check', { decision: 'deny' });
  });

  it('says how to wake an asleep computer, without connecting to it', async () => {
    api.takeoverComputer.mockResolvedValue(IN_CONTROL);
    await mount(createElement(Host, { req: captcha(), initial: computerStatus({ state: 'absent' }) }));
    expect(card().textContent).toContain('The computer is asleep — Verify here wakes it up.');
    expect(screen()).toBeNull();
    expect(fakes.FakeRfb.instances).toHaveLength(0);

    await act(async () => {
      card()
        .querySelector('[data-testid="bots-request-verify-here"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    // The take-over woke it: the screen is there, and it is the member's.
    expect(screen()?.getAttribute('data-view-only')).toBe('false');
  });

  it('collapses once settled — no screen, no actions', async () => {
    await mount(createElement(Host, { req: captcha({ status: 'resolved' }), initial: computerStatus() }));
    expect(card().textContent).toContain('Handed back');
    expect(screen()).toBeNull();
    expect(fakes.FakeRfb.instances).toHaveLength(0);
    expect(card().querySelector('[data-testid="bots-request-verify-here"]')).toBeNull();
  });

  it('stays a plain take-over card for anything that is not a human check', async () => {
    const other = request({
      id: 'brq_other',
      kind: 'takeover',
      payload: { reason: 'Pick the delivery slot', kind: 'other', url: null },
    });
    await mount(createElement(Host, { req: other, initial: computerStatus() }));
    expect(card().textContent).toContain('Sage needs you to take over');
    expect(screen()).toBeNull();
  });
});

describe('a message waiting for the current reply', () => {
  const queued: PendingSend = {
    clientId: 'send-1',
    content: 'Also check the invoices',
    images: [],
    status: 'queued',
    afterSegment: 0,
  };

  it('offers "Handle now" while a run is going', async () => {
    const onHandleNow = vi.fn();
    await mount(createElement(BotTranscript, props({ pending: [queued], busy: true, onHandleNow })));
    const bubble = document.querySelector('[data-testid="bots-pending-send"]')!;
    expect(bubble.textContent).toContain('Delivered — read after the current reply');

    await act(async () => {
      bubble
        .querySelector('[data-testid="bots-pending-handle-now"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onHandleNow).toHaveBeenCalledWith('send-1');
  });

  it('says it is next once the run stops after this step (or the member asked)', async () => {
    await mount(
      createElement(BotTranscript, props({ pending: [queued], busy: true, interrupting: true, onHandleNow: vi.fn() })),
    );
    const bubble = document.querySelector('[data-testid="bots-pending-send"]')!;
    expect(bubble.textContent).toContain('Read as soon as the current step finishes');
    expect(bubble.querySelector('[data-testid="bots-pending-handle-now"]')).toBeNull();

    await rerender(
      createElement(BotTranscript, props({ pending: [{ ...queued, nudged: true }], busy: true, onHandleNow: vi.fn() })),
    );
    expect(document.querySelector('[data-testid="bots-pending-send"]')?.textContent).toContain(
      'Read as soon as the current step finishes',
    );
  });

  it('offers nothing to hurry when no run is going', async () => {
    await mount(createElement(BotTranscript, props({ pending: [queued], busy: false, onHandleNow: vi.fn() })));
    expect(document.querySelector('[data-testid="bots-pending-handle-now"]')).toBeNull();
  });
});
