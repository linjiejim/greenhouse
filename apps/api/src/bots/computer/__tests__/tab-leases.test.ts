import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright-core';
import {
  ContextBook,
  FOREIGN_CONTEXT_GRACE_MS,
  LeaseRegistry,
  leaseRegistryFor,
  leaseTag,
  planTabEvictions,
  targetIdOf,
  MAX_TABS_PER_COMPUTER,
  type TabUsage,
} from '../tab-leases.js';
import { BOT_TASK_TIMEOUT_MS } from '../../engine/tasks.js';
import { chromiumAvailable, launchTestChromium, type TestChromium } from '../../__tests__/helpers/chromium.js';
import { startFixtureSite, type FixtureSite } from '../../__tests__/helpers/fixture-server.js';

describe('planTabEvictions', () => {
  const tab = (leaseKey: string, tabId: string, lastUsedAt: number, current = false): TabUsage => ({
    leaseKey,
    tabId,
    lastUsedAt,
    current,
  });

  it('closes the oldest non-current tab of a full lease first', () => {
    const tabs = [tab('A', 'a1', 1, true), tab('A', 'a2', 2), tab('A', 'a3', 3)];
    expect(planTabEvictions(tabs, { targetLease: 'A', incoming: 1 })).toEqual(['a2']);
  });

  it('closes least recently used tabs of other leases when the computer is full', () => {
    const tabs = [
      ...['1', '2', '3'].map((n, i) => tab('B', `b${n}`, 10 + i)),
      ...['1', '2', '3'].map((n, i) => tab('C', `c${n}`, 20 + i)),
      ...['1', '2', '3'].map((n, i) => tab('D', `d${n}`, 5 + i)),
      tab('A', 'a1', 1, true),
    ];
    // 10 tabs + 1 incoming into A (which has room) → close the single oldest elsewhere.
    expect(planTabEvictions(tabs, { targetLease: 'A', incoming: 1 })).toEqual(['d1']);
  });

  it('never closes tabs of the lease that is making room unless it is itself over its cap', () => {
    const tabs = Array.from({ length: 10 }, (_, i) => tab(i < 2 ? 'A' : `L${i}`, `t${i}`, i));
    const victims = planTabEvictions(tabs, { targetLease: 'A', incoming: 1 });
    expect(victims).toEqual(['t2']);
  });

  it('a new lease (no tabs yet) makes room across the computer', () => {
    const tabs = Array.from({ length: MAX_TABS_PER_COMPUTER }, (_, i) => tab(`L${i}`, `t${i}`, 100 - i));
    expect(planTabEvictions(tabs, { targetLease: 'new', incoming: 1 })).toEqual(['t9']);
  });

  it('does nothing when there is room', () => {
    expect(planTabEvictions([tab('A', 'a1', 1)], { targetLease: 'A', incoming: 1 })).toEqual([]);
  });
});

describe('ContextBook (which browser contexts a connection may dispose)', () => {
  it("disposes this process's contexts at once, another process's only after the grace", () => {
    let now = 1_000;
    const book = new ContextBook(() => now);
    book.addOwn('mine');
    expect(book.disposable('mine')).toBe(true);
    expect(book.disposable('theirs')).toBe(false); // first sight
    now += FOREIGN_CONTEXT_GRACE_MS - 1;
    expect(book.disposable('theirs')).toBe(false);
    now += 1;
    expect(book.disposable('theirs')).toBe(true);
  });

  it('outlasts the longest a background task can hold its context', () => {
    expect(FOREIGN_CONTEXT_GRACE_MS).toBeGreaterThan(BOT_TASK_TIMEOUT_MS);
  });

  it('forgets contexts that are gone, and adopting a context clears its foreign clock', () => {
    let now = 0;
    const book = new ContextBook(() => now);
    expect(book.disposable('x')).toBe(false);
    book.retain(new Set());
    now = FOREIGN_CONTEXT_GRACE_MS * 2;
    expect(book.disposable('x')).toBe(false); // seen again for the first time
    book.addOwn('x');
    book.forget('x');
    expect(book.disposable('x')).toBe(false);
  });
});

describe.skipIf(!chromiumAvailable())('tab leases on a real browser', { timeout: 90_000 }, () => {
  let chromium: TestChromium;
  let site: FixtureSite;
  let registry: LeaseRegistry;

  beforeAll(async () => {
    site = await startFixtureSite();
    chromium = await launchTestChromium();
    registry = leaseRegistryFor(chromium.browser);
  });
  afterAll(async () => {
    await chromium?.close();
    await site?.close();
  });
  afterEach(async () => {
    for (const lease of registry.list()) await registry.release(lease.key);
  });

  async function windowOf(page: Page): Promise<number> {
    const cdp = await chromium.browser.newBrowserCDPSession();
    const targetId = await targetIdOf(page.context(), page);
    const { windowId } = (await cdp.send('Browser.getWindowForTarget', { targetId: targetId! })) as {
      windowId: number;
    };
    await cdp.detach();
    return windowId;
  }

  it('gives the same Bot different tabs (and windows) in different conversations', async () => {
    const dm = await registry.acquire({ kind: 'foreground', botId: 'bot_a', sessionId: 's_dm' }, { create: true });
    const group = await registry.acquire(
      { kind: 'foreground', botId: 'bot_a', sessionId: 's_group' },
      { create: true },
    );
    expect(dm && group).toBeTruthy();
    const dmPage = dm!.currentPage()!;
    const groupPage = group!.currentPage()!;
    expect(dmPage).not.toBe(groupPage);
    expect(await targetIdOf(dmPage.context(), dmPage)).not.toBe(await targetIdOf(groupPage.context(), groupPage));
    expect(await windowOf(dmPage)).not.toBe(await windowOf(groupPage));
    // Both live in the persistent default context (shared logins).
    expect(dmPage.context()).toBe(chromium.browser.contexts()[0]);
    // The same key returns the same lease.
    const again = await registry.acquire({ kind: 'foreground', botId: 'bot_a', sessionId: 's_dm' }, { create: true });
    expect(again).toBe(dm);
  });

  it('shares one window when two calls race for the same lease', async () => {
    const spec = { kind: 'foreground', botId: 'bot_race', sessionId: 's1' } as const;
    const [a, b] = await Promise.all([
      registry.acquire(spec, { create: true }),
      registry.acquire(spec, { create: true }),
    ]);
    expect(a).toBe(b);
    expect(a!.tabs).toHaveLength(1);
  });

  it('does not create a lease when asked only to look', async () => {
    expect(
      await registry.acquire({ kind: 'foreground', botId: 'bot_x', sessionId: 'none' }, { create: false }),
    ).toBeNull();
  });

  it('tags foreground windows and re-adopts them from a new connection (API restart)', async () => {
    const spec = { kind: 'foreground', botId: 'bot_r', sessionId: 's_r' } as const;
    const lease = await registry.acquire(spec, { create: true });
    const page = lease!.currentPage()!;
    await page.goto(`${site.origin}/page2`);
    await registry.retag(lease!, page);
    expect(await page.evaluate(() => window.name)).toBe(leaseTag('bot_r', 's_r'));

    const second = await chromium.reconnect();
    const fresh = leaseRegistryFor(second);
    const adopted = await fresh.acquire(spec, { create: true });
    expect(adopted!.currentPage()!.url()).toBe(`${site.origin}/page2`);
    // A different conversation does not pick it up.
    const other = await fresh.acquire({ kind: 'foreground', botId: 'bot_r', sessionId: 'other' }, { create: false });
    expect(other).toBeNull();
    await second.close();
  });

  it('runs background turns in a clean, cookie-less context and closes it on release', async () => {
    const fg = await registry.acquire({ kind: 'foreground', botId: 'bot_c', sessionId: 's_c' }, { create: true });
    await fg!.currentPage()!.goto(`${site.origin}/home`);
    await fg!.context.addCookies([{ name: 'session', value: 'member-cookie', url: site.origin }]);

    const bg = await registry.acquire({ kind: 'background', turnId: 'run_1' }, { create: true });
    expect(bg!.context).not.toBe(fg!.context);
    expect(await bg!.context.cookies(site.origin)).toEqual([]);
    await registry.release(bg!.key);
    expect(bg!.context.pages()).toHaveLength(0);
  });

  it("two API slots on one computer never dispose each other's live background context", async () => {
    // Each slot is its own process: its own connection and its own book.
    let clock = Date.now();
    const blueBook = new ContextBook(() => clock);
    const greenBook = new ContextBook(() => clock);
    const blueConn = await chromium.reconnect();
    const greenConn = await chromium.reconnect();
    try {
      const green = new LeaseRegistry(greenConn, greenBook);
      const task = await green.acquire({ kind: 'background', turnId: 'task:green_run' }, { create: true });
      const taskPage = task!.currentPage()!;
      await taskPage.goto(`${site.origin}/page2`);
      expect(task!.contextId).toBeTruthy();

      // Blue connects (a foreground turn) while green's task is running.
      const blue = new LeaseRegistry(blueConn, blueBook);
      await blue.acquire({ kind: 'foreground', botId: 'bot_blue', sessionId: 's_blue' }, { create: true });
      expect(await blue.sweepContexts()).toBe(0);
      expect(taskPage.isClosed()).toBe(false);
      expect(await taskPage.evaluate(() => document.title)).toBe('Second page');

      // Green's own sweep keeps its live lease, too.
      expect(await green.sweepContexts()).toBe(0);

      // Told the other owner is gone, blue's next sweep would take it at
      // once — but never green's own live lease in green's sweep.
      green.expireForeign();
      expect(await green.sweepContexts()).toBe(0);

      // Long after any task could still run, the leftover is swept.
      clock += FOREIGN_CONTEXT_GRACE_MS;
      expect(await blue.sweepContexts()).toBe(1);
      await expect.poll(() => taskPage.isClosed()).toBe(true);
    } finally {
      await blueConn.close().catch(() => undefined);
      await greenConn.close().catch(() => undefined);
    }
  });

  it('a slot that knows the previous owner is gone sweeps its leftovers at once', async () => {
    const goneBook = new ContextBook();
    const takerBook = new ContextBook();
    const goneConn = await chromium.reconnect();
    const takerConn = await chromium.reconnect();
    try {
      const gone = new LeaseRegistry(goneConn, goneBook);
      const leftover = await gone.acquire({ kind: 'background', turnId: 'task:gone' }, { create: true });
      const page = leftover!.currentPage()!;
      const taker = new LeaseRegistry(takerConn, takerBook);
      taker.expireForeign(); // e.g. it claimed the DevTools connection from a stale owner
      await taker.acquire({ kind: 'foreground', botId: 'bot_taker', sessionId: 's' }, { create: false });
      await expect.poll(() => page.isClosed()).toBe(true);
    } finally {
      await goneConn.close().catch(() => undefined);
      await takerConn.close().catch(() => undefined);
    }
  });

  it("a new connection of the same process disposes that process's orphaned background contexts at once", async () => {
    const book = new ContextBook();
    const oldConn = await chromium.reconnect();
    const newConn = await chromium.reconnect();
    try {
      const before = new LeaseRegistry(oldConn, book);
      const orphan = await before.acquire({ kind: 'background', turnId: 'task:old' }, { create: true });
      const page = orphan!.currentPage()!;
      // The old connection drops without releasing (an API crash); a new one
      // of the same process takes over.
      const after = new LeaseRegistry(newConn, book);
      await after.acquire({ kind: 'foreground', botId: 'bot_new', sessionId: 's_new' }, { create: false });
      await expect.poll(() => page.isClosed()).toBe(true);
    } finally {
      await oldConn.close().catch(() => undefined);
      await newConn.close().catch(() => undefined);
    }
  });

  it('adopts popups into the lease, switches to them, and keeps ≤3 tabs per lease', async () => {
    const lease = await registry.acquire({ kind: 'foreground', botId: 'bot_p', sessionId: 's_p' }, { create: true });
    const page = lease!.currentPage()!;
    await page.goto(`${site.origin}/home`);
    for (let i = 0; i < 3; i++) {
      const popup = page.context().waitForEvent('page');
      await page.click('a[target=_blank]');
      await (await popup).waitForLoadState();
      await new Promise((r) => setTimeout(r, 100));
      lease!.select(page);
    }
    await new Promise((r) => setTimeout(r, 300));
    expect(lease!.tabs.length).toBeLessThanOrEqual(3);
    expect(lease!.pages()).toContain(page);
  });

  it('caps the computer at 10 tabs, closing the least recently used lease', async () => {
    const leases = [];
    for (let i = 0; i < MAX_TABS_PER_COMPUTER + 1; i++) {
      leases.push(
        await registry.acquire({ kind: 'foreground', botId: `bot_${i}`, sessionId: 'cap' }, { create: true }),
      );
    }
    const live = registry.list().reduce((n, lease) => n + lease.tabs.length, 0);
    expect(live).toBeLessThanOrEqual(MAX_TABS_PER_COMPUTER);
    // The first (least recently used) lease made room for the last.
    expect(leases[0]!.tabs).toHaveLength(0);
    expect(leases[MAX_TABS_PER_COMPUTER]!.tabs).toHaveLength(1);
  });

  it('screenshots a window that is not in front within seconds', async () => {
    const a = await registry.acquire({ kind: 'foreground', botId: 'bot_s1', sessionId: 's' }, { create: true });
    const b = await registry.acquire({ kind: 'foreground', botId: 'bot_s2', sessionId: 's' }, { create: true });
    await a!.currentPage()!.goto(`${site.origin}/page2`);
    await b!.currentPage()!.bringToFront();
    const started = Date.now();
    const png = await a!.currentPage()!.screenshot({ timeout: 5_000 });
    expect(png.length).toBeGreaterThan(100);
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
