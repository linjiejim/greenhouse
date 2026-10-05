import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseProvider } from '@greenhouse/db';
import { abortComputerActions } from '../access.js';
import {
  BrowserSession,
  normalizeBrowseUrl,
  type ComputerTurn,
  type Observation,
  type ToolFailure,
} from '../browser-session.js';
import { leaseRegistryFor } from '../tab-leases.js';
import {
  chromiumAvailable,
  fakeComputer,
  launchTestChromium,
  type FakeComputer,
  type TestChromium,
} from '../../__tests__/helpers/chromium.js';
import { startFixtureSite, type FixtureSite } from '../../__tests__/helpers/fixture-server.js';

describe('normalizeBrowseUrl', () => {
  it('assumes https and keeps http(s) only', () => {
    expect(normalizeBrowseUrl('github.com/login')).toEqual({ url: 'https://github.com/login' });
    expect(normalizeBrowseUrl('http://example.com')).toEqual({ url: 'http://example.com/' });
    expect(normalizeBrowseUrl('about:blank')).toEqual({ url: 'about:blank' });
    for (const bad of [
      'file:///etc/passwd',
      'chrome://settings',
      'javascript:alert(1)',
      'view-source:https://x.com',
      'data:text/html,hi',
    ]) {
      expect(normalizeBrowseUrl(bad)).toMatchObject({ code: 'url_forbidden' });
    }
    expect(normalizeBrowseUrl('')).toMatchObject({ code: 'url_invalid' });
  });

  it("refuses greenhouse's own origin", () => {
    const before = process.env.PUBLIC_BASE_URL;
    process.env.PUBLIC_BASE_URL = 'https://gh.example.com';
    try {
      expect(normalizeBrowseUrl('https://gh.example.com/#/bots')).toMatchObject({ code: 'url_forbidden' });
    } finally {
      if (before === undefined) delete process.env.PUBLIC_BASE_URL;
      else process.env.PUBLIC_BASE_URL = before;
    }
  });
});

function isFailure(result: Observation | ToolFailure): result is ToolFailure {
  return !('url' in result);
}

describe.skipIf(!chromiumAvailable())('BrowserSession on a real browser', { timeout: 90_000 }, () => {
  let chromium: TestChromium;
  let site: FixtureSite;
  let computer: FakeComputer;
  let n = 0;

  beforeAll(async () => {
    site = await startFixtureSite();
    chromium = await launchTestChromium();
  });
  afterAll(async () => {
    await chromium?.close();
    await site?.close();
  });
  afterEach(async () => {
    const registry = leaseRegistryFor(chromium.browser);
    for (const lease of registry.list()) await registry.release(lease.key);
  });

  function session(overrides: Partial<ComputerTurn> = {}) {
    computer = fakeComputer(chromium.browser);
    const turn: ComputerTurn = {
      db: {} as DatabaseProvider,
      userId: 'u1',
      botId: `bot_${++n}`,
      sessionId: 's1',
      turnId: `turn_${n}`,
      background: false,
      signal: new AbortController().signal,
      markTainted: vi.fn(),
      noteObservation: vi.fn(),
      vaultMatches: null,
      implicitTakeover: vi.fn(async () => 'card' as const),
      ...overrides,
    };
    return { turn, run: new BrowserSession(turn, computer.deps) };
  }

  /** The page and lease of a foreground session's tab. */
  const leaseOf = (turn: ComputerTurn) =>
    leaseRegistryFor(chromium.browser).get({ kind: 'foreground', botId: turn.botId, sessionId: turn.sessionId })!;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * A form whose input handler keeps the page busy, so a fill takes ~600 ms.
   * The handler first tells the site (a synchronous POST /fill-started), so a
   * test can act exactly while the fill is in progress, however slow the host.
   */
  function slowForm(): string {
    site.submissions.length = 0;
    site.pages.set(
      '/slow-form',
      `<!doctype html><title>Slow form</title><form method="post" action="/slow-post">
        <label>Query <input name="q" oninput="fillStarted(); const t = Date.now(); while (Date.now() - t < 600) {} window.__fillEnd = Date.now();"></label>
        <button>Go</button></form>
        <script>
          function fillStarted() {
            const x = new XMLHttpRequest();
            x.open('POST', '/fill-started', false);
            x.send('');
          }
        </script>`,
    );
    return `${site.origin}/slow-form`;
  }

  const fillInProgress = () =>
    vi.waitFor(() => expect(site.submissions.some((s) => s.path === '/fill-started')).toBe(true), {
      timeout: 10_000,
      interval: 10,
    });

  const refOf = (snapshot: string, pattern: RegExp) => {
    const line = snapshot.split('\n').find((l) => pattern.test(l));
    return /\[ref=([^\]]+)\]/.exec(line ?? '')?.[1] ?? '';
  };

  it('asks for open first, then opens, observes and marks the turn tainted', async () => {
    const { turn, run } = session();
    expect(await run.run({ action: 'snapshot' })).toMatchObject({ code: 'no_tab' });
    const result = await run.run({ action: 'open', url: `${site.origin}/home` });
    expect(isFailure(result)).toBe(false);
    expect(result).toMatchObject({ url: `${site.origin}/home`, title: 'Dashboard' });
    expect((result as Observation).snapshot).toContain('heading "Welcome back"');
    expect(turn.markTainted).toHaveBeenCalled();
  });

  it("records the observed page's origin (and every listed tab's) for the vault's foreign-read rule", async () => {
    const { turn, run } = session();
    const home = (await run.run({ action: 'open', url: `${site.origin}/home` })) as Observation;
    expect(turn.noteObservation).toHaveBeenCalledWith(site.origin);
    // The ledger is fed before the taint flag is set: it can tell whether
    // something else tainted the turn first.
    const noteOrder = vi.mocked(turn.noteObservation).mock.invocationCallOrder[0]!;
    expect(noteOrder).toBeLessThan(vi.mocked(turn.markTainted).mock.invocationCallOrder[0]!);
    vi.mocked(turn.noteObservation).mockClear();
    await run.run({ action: 'click', ref: refOf(home.snapshot, /link "Open report"/) });
    await run.run({ action: 'tabs' });
    expect(vi.mocked(turn.noteObservation).mock.calls.every(([origin]) => origin === site.origin)).toBe(true);
    // A blank tab is not content: nothing to record.
    vi.mocked(turn.noteObservation).mockClear();
    await run.run({ action: 'open', url: 'about:blank' });
    expect(turn.noteObservation).toHaveBeenCalledTimes(1); // the other (report) tab, listed
  });

  it('clicks, types, selects, presses, scrolls and goes back', async () => {
    const { run } = session();
    const home = (await run.run({ action: 'open', url: `${site.origin}/home` })) as Observation;

    const select = (await run.run({
      action: 'select',
      ref: refOf(home.snapshot, /combobox "Plan"/),
      value: 'Pro plan',
    })) as Observation;
    expect(select.snapshot).toMatch(/option "Pro plan" \[selected\]/);

    const typed = (await run.run({
      action: 'type',
      ref: refOf(home.snapshot, /searchbox "Search"/),
      text: 'quarterly',
    })) as Observation;
    expect(typed.snapshot).toMatch(
      /searchbox "Search" \[active\] \[ref=e\d+\]: quarterly|searchbox "Search".*quarterly/,
    );

    expect(await run.run({ action: 'scroll', direction: 'down' })).toMatchObject({ url: `${site.origin}/home` });
    expect(await run.run({ action: 'press', key: 'Tab' })).toMatchObject({ url: `${site.origin}/home` });
    expect(await run.run({ action: 'press', key: 'rm -rf' })).toMatchObject({ code: 'invalid' });

    const next = (await run.run({ action: 'click', ref: refOf(home.snapshot, /link "Next page"/) })) as Observation;
    expect(next).toMatchObject({ url: `${site.origin}/page2`, title: 'Second page' });

    const back = (await run.run({ action: 'back' })) as Observation;
    expect(back.url).toBe(`${site.origin}/home`);
  });

  it('reports a stale ref with a fresh snapshot instead of failing blind', async () => {
    const { run } = session();
    await run.run({ action: 'open', url: `${site.origin}/page2` });
    const result = (await run.run({ action: 'click', ref: 'e999' })) as Observation;
    expect(result.code).toBe('stale_ref');
    expect(result.snapshot).toContain('Second page');
    expect(await run.run({ action: 'click', ref: '; drop' })).toMatchObject({ code: 'invalid' });
  }, 30_000);

  it('follows a target=_blank link into a new tab, lists, switches and closes tabs', async () => {
    const { run } = session();
    const home = (await run.run({ action: 'open', url: `${site.origin}/home` })) as Observation;
    const report = (await run.run({ action: 'click', ref: refOf(home.snapshot, /link "Open report"/) })) as Observation;
    expect(report.title).toBe('Report');
    expect(report.tabs).toHaveLength(2);
    expect(report.tabs!.find((t) => t.current)?.url).toBe(`${site.origin}/popup`);

    const first = (await run.run({ action: 'tabs', tab: 1 })) as Observation;
    expect(first.title).toBe('Dashboard');
    const closed = (await run.run({ action: 'close' })) as Observation;
    expect(closed.title).toBe('Report');
    const last = (await run.run({ action: 'close' })) as Observation;
    expect(last.note).toMatch(/tab is closed/);
    expect(await run.run({ action: 'tabs' })).toMatchObject({ tabs: [] });
  });

  it('refuses to type into password fields', async () => {
    const { run } = session();
    const login = (await run.run({ action: 'open', url: `${site.origin}/login` })) as Observation;
    const result = await run.run({ action: 'type', ref: refOf(login.snapshot, /textbox "Password"/), text: 'guess' });
    expect(result).toMatchObject({ code: 'secret_field' });
  });

  it('hints at vault entries on a sign-in page, else at the secure sign-in card', async () => {
    const vaultMatches = vi.fn(async () => [
      { id: 'vlt_9', label: 'Fixture', username_hint: 'me***@x.com', has_password: true, has_totp: false },
    ]);
    const withVault = session({ vaultMatches });
    const hinted = (await withVault.run.run({ action: 'open', url: `${site.origin}/login` })) as Observation;
    expect(hinted.hint).toContain('vlt_9');
    expect(vaultMatches).toHaveBeenCalledWith(site.origin);

    const without = session();
    const plain = (await without.run.run({ action: 'open', url: `${site.origin}/captcha` })) as Observation;
    expect(plain.hint).toMatch(/kind "captcha"/);
  });

  it('never shows secrets on a page with filled credentials', async () => {
    const { run } = session();
    const result = (await run.run({ action: 'open', url: `${site.origin}/prefilled` })) as Observation;
    expect(result.snapshot).not.toContain('hunter2-Secret!');
    expect(result.snapshot).not.toContain('482913');
  });

  it('refuses to act or observe while the member holds the computer, leaving a card for the hand-back', async () => {
    const implicitTakeover = vi.fn(async () => 'card' as const);
    const { run, turn } = session({ implicitTakeover });
    await run.run({ action: 'open', url: `${site.origin}/home` });
    computer.lease = { controller: 'user', epoch: 1 };
    (turn.markTainted as ReturnType<typeof vi.fn>).mockClear();
    const refused = await run.run({ action: 'snapshot' });
    expect(refused).toMatchObject({ code: 'user_in_control' });
    expect(implicitTakeover).toHaveBeenCalledWith({ reason: 'waiting' });
    // The promise is true now: a card waits for the hand-back, which wakes the Bot.
    expect((refused as ToolFailure).error).toMatch(/A card asks them to hand it back.*woken automatically/);
    expect(turn.markTainted).not.toHaveBeenCalled();
  });

  it('promises no wake-up it cannot keep: background tasks, or no card', async () => {
    const background = session({ background: true, turnId: 'bg_member' });
    await background.run.run({ action: 'open', url: `${site.origin}/home` });
    computer.lease = { controller: 'user', epoch: 1 };
    const bg = (await background.run.run({ action: 'snapshot' })) as ToolFailure;
    expect(bg.code).toBe('user_in_control');
    expect(bg.error).toMatch(/background task cannot use it/);
    expect(bg.error).not.toMatch(/woken/);

    const failing = session({
      implicitTakeover: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    computer.lease = { controller: 'user', epoch: 1 };
    const noCard = (await failing.run.run({ action: 'snapshot' })) as ToolFailure;
    expect(noCard.code).toBe('user_in_control');
    expect(noCard.error).not.toMatch(/woken automatically/);
  });

  it('drops an observation taken across a take-over (epoch change)', async () => {
    const { run } = session();
    await run.run({ action: 'open', url: `${site.origin}/home` });
    let calls = 0;
    computer.deps.currentLease = async () => ({ controller: 'bot', epoch: calls++ === 0 ? 4 : 5 });
    const result = await run.run({ action: 'snapshot' });
    expect(result).toMatchObject({ code: 'observation_dropped' });
    expect(JSON.stringify(result)).not.toContain('Welcome back');
  });

  it('takes the page back to blank if it lands on file:// or greenhouse', async () => {
    const { run, turn } = session();
    await run.run({ action: 'open', url: `${site.origin}/home` });
    const registry = leaseRegistryFor(chromium.browser);
    const page = registry.get({ kind: 'foreground', botId: turn.botId, sessionId: turn.sessionId })!.currentPage()!;
    await page.goto('file:///etc/hosts').catch(() => undefined);
    const result = await run.run({ action: 'snapshot' });
    expect(result).toMatchObject({ code: 'url_forbidden' });
    expect(page.url()).toBe('about:blank');
  });

  it("stores screenshots as the conversation's chat files, never as public uploads", async () => {
    const { run, turn } = session();
    await run.run({ action: 'open', url: `${site.origin}/page2` });
    const shot = (await run.run({ action: 'screenshot' })) as Observation;
    expect(shot).toMatchObject({ type: 'file', content_type: 'image/png', file_id: 'cf_shot_1' });
    expect(shot.download_url).toMatch(/^\/api\/chat-files\/[^/]+\/content$/);
    expect(JSON.stringify(shot)).not.toContain('/api/upload/');
    expect(shot.note).not.toMatch(/!\[/); // the Bot is not invited to paste a link
    expect(computer.screenshotOwners).toEqual([{ userId: 'u1', sessionId: turn.sessionId }]);
    expect(computer.screenshots[0]!.subarray(1, 4).toString()).toBe('PNG');
  });

  it('gives background turns a read-only, signed-out browser', async () => {
    const { run } = session({ background: true, turnId: 'bg_run' });
    const opened = (await run.run({ action: 'open', url: `${site.origin}/home` })) as Observation;
    expect(opened.title).toBe('Dashboard');
    expect(await run.run({ action: 'click', ref: 'e3' })).toMatchObject({ code: 'not_allowed' });
    expect(await run.run({ action: 'type', ref: 'e3', text: 'x' })).toMatchObject({ code: 'not_allowed' });
    const lease = leaseRegistryFor(chromium.browser).get({ kind: 'background', turnId: 'bg_run' })!;
    expect(lease.context).not.toBe(chromium.browser.contexts()[0]);
  });

  it('does not act when the member takes over while the action waits in the queue', async () => {
    const { run, turn } = session();
    const home = (await run.run({ action: 'open', url: `${site.origin}/home` })) as Observation;
    const lease = leaseOf(turn);
    // Another action of this turn holds the lease; the click queues behind it.
    const occupant = lease.run(() => sleep(300));
    const click = run.run({ action: 'click', ref: refOf(home.snapshot, /link "Next page"/) });
    await sleep(50);
    computer.lease = { controller: 'user', epoch: 1 };
    expect(await click).toMatchObject({ code: 'user_in_control' });
    expect(turn.implicitTakeover).toHaveBeenCalledWith(expect.objectContaining({ reason: 'interrupted' }));
    await occupant;
    expect(lease.currentPage()!.url()).toBe(`${site.origin}/home`);
  });

  it('a take-over in this process stops a typed submit between the fill and the Enter', async () => {
    const { run, turn } = session();
    const form = (await run.run({ action: 'open', url: slowForm() })) as Observation;
    const typing = run.run({
      action: 'type',
      ref: refOf(form.snapshot, /textbox "Query"/),
      text: 'quarterly',
      submit: true,
    });
    await fillInProgress();
    // What takeoverComputer does in this process, while the fill is running:
    // the lease goes to the member, then the actions in flight are aborted.
    computer.lease = { controller: 'user', epoch: 1 };
    expect(abortComputerActions('u1')).toBe(1);
    const stopped = (await typing) as ToolFailure;
    expect(stopped.code).toBe('user_in_control');
    expect(stopped.error).toMatch(/took over the computer while you were working.*woken automatically/);
    // The card says where the Bot was (server-derived host, the page's title).
    expect(turn.implicitTakeover).toHaveBeenCalledTimes(1);
    expect(turn.implicitTakeover).toHaveBeenCalledWith({
      reason: 'interrupted',
      host: '127.0.0.1',
      title: 'Slow form',
    });
    await sleep(800);
    expect(site.submissions.filter((s) => s.path === '/slow-post')).toEqual([]);
  });

  it('a take-over the member already handed back leaves no card: the Bot looks again', async () => {
    const { run, turn } = session();
    const form = (await run.run({ action: 'open', url: slowForm() })) as Observation;
    const typing = run.run({
      action: 'type',
      ref: refOf(form.snapshot, /textbox "Query"/),
      text: 'quarterly',
      submit: true,
    });
    await fillInProgress();
    abortComputerActions('u1');
    computer.lease = { controller: 'bot', epoch: 2 }; // taken and given back before the tool noticed
    const result = (await typing) as ToolFailure;
    expect(result.code).toBe('observation_dropped');
    expect(result.error).toMatch(/already handed it back.*fresh snapshot/);
    expect(turn.implicitTakeover).not.toHaveBeenCalled();
  });

  it('a take-over on another API slot (DB lease only) also stops the Enter after a fill', async () => {
    const { run, turn } = session();
    const form = (await run.run({ action: 'open', url: slowForm() })) as Observation;
    const page = leaseOf(turn).currentPage()!;
    // The lease flips in the DB as soon as the text is in the field.
    computer.deps.currentLease = async () =>
      (await page.inputValue('input[name=q]')) ? { controller: 'user', epoch: 1 } : { controller: 'bot', epoch: 0 };
    const result = await run.run({
      action: 'type',
      ref: refOf(form.snapshot, /textbox "Query"/),
      text: 'quarterly',
      submit: true,
    });
    expect(result).toMatchObject({ code: 'user_in_control' });
    expect(turn.implicitTakeover).toHaveBeenCalledWith(expect.objectContaining({ reason: 'interrupted' }));
    await sleep(300);
    expect(site.submissions.filter((s) => s.path === '/slow-post')).toEqual([]);
  });

  it('a stopped call gives up at once, but the next turn waits for its orphaned page work', async () => {
    const stop = new AbortController();
    const first = session({ signal: stop.signal });
    const form = (await first.run.run({ action: 'open', url: slowForm() })) as Observation;
    const page = leaseOf(first.turn).currentPage()!;
    const typing = first.run.run({ action: 'type', ref: refOf(form.snapshot, /textbox "Query"/), text: 'x' });
    await fillInProgress();
    stop.abort();
    expect(await typing).toMatchObject({ code: 'aborted' });

    // A new turn of the same Bot in the same conversation: its action must
    // not start while the stopped fill is still running in the page.
    const startedAt: number[] = [];
    const next = new BrowserSession(
      { ...first.turn, turnId: 'turn_next', signal: new AbortController().signal },
      {
        ...computer.deps,
        currentLease: async () => {
          startedAt.push(Date.now());
          return { ...computer.lease };
        },
      },
    );
    expect(await next.run({ action: 'snapshot' })).toMatchObject({ title: 'Slow form' });
    const fillEnd = (await page.evaluate(() => (window as unknown as { __fillEnd?: number }).__fillEnd)) ?? 0;
    expect(fillEnd).toBeGreaterThan(0);
    // [fast-path check, re-check at the real start inside the queue, after-check]
    expect(startedAt[1]!).toBeGreaterThanOrEqual(fillEnd);
  });

  it('stops when the turn is aborted', async () => {
    const controller = new AbortController();
    const { run } = session({ signal: controller.signal });
    controller.abort();
    expect(await run.run({ action: 'open', url: `${site.origin}/home` })).toMatchObject({ code: 'aborted' });
  });
});
