/**
 * Tab leases — which browser tabs a Bot turn may see and drive.
 *
 * A Bot can be busy in its DM, in a group and in a background task at the same
 * time; with one tab per Bot those runs would drive the same page, invalidate
 * each other's refs, and a page opened in a private DM would show up in a group
 * run's snapshot. So tabs are leased:
 *
 * - **Foreground** turns lease per (Bot, conversation), in the browser's
 *   default context — the persistent profile, so a site the member (or any
 *   Bot) signed into stays signed in for every Bot. The lease survives turns:
 *   the Bot comes back to the page it left.
 * - **Background** turns lease per turn, in a fresh `browser.newContext()` —
 *   no cookies, no logins, nothing to submit as the member — closed when the
 *   turn ends (or after an idle grace period if nobody says so).
 *
 * Each lease gets its own window (`Target.createTarget {newWindow:true}`): in
 * one headful window every tab but the front one is occluded and throttled,
 * and screenshots of hidden tabs hang. Pages a lease's tabs open (target=_blank
 * links, OAuth popups) join that lease and open as tabs of its window.
 *
 * The foreground window is tagged `window.name = 'gh-bot:<botId>:<sessionId>'`
 * (re-applied after every action — some sites and cross-site navigations reset
 * it) so that a restarted API process re-adopts the windows its predecessor
 * opened instead of piling up new ones. Background contexts are never
 * re-adopted, and a connection disposes only contexts that cannot be live:
 * those THIS process created on an earlier connection (their turns died with
 * it), and contexts of another process once they are older than any
 * background task can run. During a blue/green switch both API slots can
 * drive the same computer, and the other slot's background task must not lose
 * its context because this slot connected (see `ContextBook`).
 *
 * Caps: 3 tabs per lease, 10 per computer; the least recently used tab (then
 * lease) is closed to make room.
 *
 * Design: docs/specs/20261005-personal-assistant-bots.md §5, design-review R16.
 */

import { randomBytes } from 'node:crypto';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { logger } from '@greenhouse/utils/logger';
import { toErrorMessage } from '@greenhouse/utils/error';

export const MAX_TABS_PER_LEASE = 3;
export const MAX_TABS_PER_COMPUTER = 10;
/** A background lease nobody released is closed after this long without use. */
const BACKGROUND_IDLE_MS = 10 * 60_000;
const FIND_PAGE_TIMEOUT_MS = 8_000;
/**
 * A browser context another API process created is disposed only once it has
 * been seen for this long. It must exceed the longest a background task can
 * hold its context (BOT_TASK_TIMEOUT_MS, 20 min — asserted in the tests), so
 * the context of a task still running on the other slot is never pulled.
 */
export const FOREIGN_CONTEXT_GRACE_MS = 30 * 60_000;
/** How often an active registry re-checks for contexts it may now dispose. */
const CONTEXT_SWEEP_INTERVAL_MS = 60_000;

export type LeaseSpec =
  | { kind: 'foreground'; botId: string; sessionId: string }
  | { kind: 'background'; turnId: string };

export function leaseKey(spec: LeaseSpec): string {
  return spec.kind === 'foreground' ? `fg:${spec.botId}:${spec.sessionId}` : `bg:${spec.turnId}`;
}

export function leaseTag(botId: string, sessionId: string): string {
  return `gh-bot:${botId}:${sessionId}`;
}

const TAG_PATTERN = /^gh-bot:([^:]+):([^:]+)$/;

// ─── Eviction planning (pure) ─────────────────────────────

export interface TabUsage {
  leaseKey: string;
  tabId: string;
  lastUsedAt: number;
  /** The lease's current tab — closed last within its lease. */
  current: boolean;
}

/**
 * Which tabs to close so that, after `incoming` new tabs join `targetLease`,
 * no lease holds more than `perLease` tabs and the computer no more than
 * `perComputer`. Within the target lease the oldest non-current tabs go
 * first; across the computer the least recently used tabs of OTHER leases go
 * first (a whole lease when all its tabs are older than everyone else's).
 */
export function planTabEvictions(
  tabs: readonly TabUsage[],
  opts: { targetLease: string; incoming: number; perLease?: number; perComputer?: number },
): string[] {
  const perLease = opts.perLease ?? MAX_TABS_PER_LEASE;
  const perComputer = opts.perComputer ?? MAX_TABS_PER_COMPUTER;
  const closing = new Set<string>();
  const byAge = (a: TabUsage, b: TabUsage) =>
    Number(a.current) - Number(b.current) || a.lastUsedAt - b.lastUsedAt || a.tabId.localeCompare(b.tabId);

  const own = tabs.filter((t) => t.leaseKey === opts.targetLease).sort(byAge);
  let ownExcess = own.length + opts.incoming - perLease;
  for (const tab of own) {
    if (ownExcess <= 0) break;
    closing.add(tab.tabId);
    ownExcess--;
  }

  let total = tabs.length - closing.size + opts.incoming;
  if (total > perComputer) {
    const others = tabs
      .filter((t) => t.leaseKey !== opts.targetLease && !closing.has(t.tabId))
      .sort((a, b) => a.lastUsedAt - b.lastUsedAt || a.tabId.localeCompare(b.tabId));
    for (const tab of others) {
      if (total <= perComputer) break;
      closing.add(tab.tabId);
      total--;
    }
  }
  return [...closing];
}

// ─── Context ownership ────────────────────────────────────

/**
 * Which background browser contexts this API process created (by DevTools
 * `browserContextId`, across all of its connections), and when it first saw
 * each context it did not create. One per process (`processContextBook`);
 * tests give each simulated API slot its own.
 *
 * Chromium never disposes a context when a DevTools client goes (the relay
 * keeps its pipe open), so contexts outlive their connection. Rules:
 * - own, and not a live lease of the asking registry → its connection is
 *   gone, so is its turn: dispose now;
 * - not ours → maybe a task running on another slot: dispose only after
 *   FOREIGN_CONTEXT_GRACE_MS from first sight.
 */
export class ContextBook {
  private readonly own = new Set<string>();
  private readonly foreignSeen = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  addOwn(contextId: string): void {
    this.own.add(contextId);
    this.foreignSeen.delete(contextId);
  }

  forget(contextId: string): void {
    this.own.delete(contextId);
    this.foreignSeen.delete(contextId);
  }

  /** Whether a context that is not one of the asking registry's live leases may be disposed now. */
  disposable(contextId: string): boolean {
    if (this.own.has(contextId)) return true;
    const now = this.now();
    const seen = this.foreignSeen.get(contextId);
    if (seen === undefined) {
      this.foreignSeen.set(contextId, now);
      return false;
    }
    return now - seen >= FOREIGN_CONTEXT_GRACE_MS;
  }

  /** Drop bookkeeping for contexts that no longer exist. */
  retain(existing: ReadonlySet<string>): void {
    for (const id of this.own) if (!existing.has(id)) this.own.delete(id);
    for (const id of this.foreignSeen.keys()) if (!existing.has(id)) this.foreignSeen.delete(id);
  }
}

const processContextBook = new ContextBook();

// ─── Leases ───────────────────────────────────────────────

interface TabEntry {
  page: Page;
  lastUsedAt: number;
}

let tabCounter = 0;
const tabIds = new WeakMap<Page, string>();
function tabIdOf(page: Page): string {
  let id = tabIds.get(page);
  if (!id) {
    id = `t${++tabCounter}`;
    tabIds.set(page, id);
  }
  return id;
}

/**
 * One lease: its window's tabs, the tab actions go to, and a queue so that two
 * tool calls of the same turn (parallel tool calling) never drive the page at
 * once.
 */
export class TabLease {
  readonly key: string;
  readonly tabs: TabEntry[] = [];
  current: Page | null = null;
  lastUsedAt = Date.now();
  /** DevTools id of a background lease's own context (null for foreground / unknown). */
  contextId: string | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly spec: LeaseSpec,
    readonly context: BrowserContext,
    /** Background leases own their context and close it on release. */
    readonly ownsContext: boolean,
  ) {
    this.key = leaseKey(spec);
  }

  get tag(): string | null {
    return this.spec.kind === 'foreground' ? leaseTag(this.spec.botId, this.spec.sessionId) : null;
  }

  pages(): Page[] {
    return this.tabs.map((t) => t.page);
  }

  currentPage(): Page | null {
    if (this.current && !this.current.isClosed()) return this.current;
    return null;
  }

  /** Mark the lease (and a tab, default the current one) as just used. */
  touch(page: Page | null = this.current): void {
    const now = Date.now();
    this.lastUsedAt = now;
    const entry = page ? this.tabs.find((t) => t.page === page) : undefined;
    if (entry) entry.lastUsedAt = now;
  }

  select(page: Page): void {
    if (!this.tabs.some((t) => t.page === page)) return;
    this.current = page;
    this.touch(page);
  }

  /** Serialise actions on this lease. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  usage(): TabUsage[] {
    return this.tabs.map((t) => ({
      leaseKey: this.key,
      tabId: tabIdOf(t.page),
      lastUsedAt: t.lastUsedAt,
      current: t.page === this.current,
    }));
  }
}

/**
 * Per-connection lease bookkeeping. Keyed by the Browser object: a reconnect
 * yields a new Browser, hence a fresh registry that re-adopts tagged windows.
 */
export class LeaseRegistry {
  private readonly leases = new Map<string, TabLease>();
  private readonly pending = new Map<string, Promise<TabLease>>();
  private readonly owners = new WeakMap<Page, TabLease>();
  private readonly instrumented = new WeakSet<Page>();
  private cdp: Promise<CDPSession> | null = null;
  private ready: Promise<void> | null = null;
  private lastSweepAt = 0;
  private foreignOwnerGone = false;

  constructor(
    readonly browser: Browser,
    private readonly book: ContextBook = processContextBook,
  ) {}

  /** The browser's persistent (default) context — shared logins. */
  defaultContext(): BrowserContext {
    const context = this.browser.contexts()[0];
    if (!context) throw new Error('The computer browser has no default context');
    return context;
  }

  get(spec: LeaseSpec): TabLease | undefined {
    const lease = this.leases.get(leaseKey(spec));
    return lease && lease.tabs.length > 0 ? lease : undefined;
  }

  /** All live leases (for tests and diagnostics). */
  list(): TabLease[] {
    return [...this.leases.values()].filter((l) => l.tabs.length > 0);
  }

  /**
   * The lease for a spec: the live one (windows a previous API process opened
   * are re-adopted on first use), or — when `create` — a new window.
   * Concurrent calls for the same key share one creation.
   */
  async acquire(spec: LeaseSpec, opts: { create: boolean }): Promise<TabLease | null> {
    this.ready ??= this.takeOver();
    await this.ready;
    this.closeIdleBackgroundLeases();
    if (Date.now() - this.lastSweepAt >= CONTEXT_SWEEP_INTERVAL_MS) void this.sweepContexts();
    const key = leaseKey(spec);
    const live = this.get(spec);
    if (live) return live;
    if (!opts.create) return null;
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    const creating = this.openLease(spec);
    this.pending.set(key, creating);
    try {
      return await creating;
    } finally {
      this.pending.delete(key);
    }
  }

  /** Close a lease's tabs (and its context, for background leases). */
  async release(key: string): Promise<void> {
    const lease = this.leases.get(key);
    if (!lease) return;
    this.leases.delete(key);
    if (lease.ownsContext) {
      await lease.context.close().catch(() => undefined);
      if (lease.contextId) this.book.forget(lease.contextId);
      return;
    }
    await Promise.all(lease.pages().map((p) => p.close().catch(() => undefined)));
  }

  /** Re-apply the window tag of a foreground lease (cheap no-op when it is still there). */
  async retag(lease: TabLease, page: Page): Promise<void> {
    const tag = lease.tag;
    if (!tag || page !== lease.tabs[0]?.page) return;
    await page
      .evaluate((name) => {
        if (window.name !== name) window.name = name;
      }, tag)
      .catch(() => undefined);
  }

  /** Make room for `incoming` tabs in `lease`, closing least recently used tabs. */
  async enforceCaps(lease: TabLease | null, incoming: number, targetKey = lease?.key ?? ''): Promise<void> {
    const usage = this.list().flatMap((l) => l.usage());
    const victims = new Set(planTabEvictions(usage, { targetLease: targetKey, incoming }));
    if (victims.size === 0) return;
    const closing: Promise<void>[] = [];
    for (const l of this.list()) {
      for (const tab of l.tabs) {
        if (victims.has(tabIdOf(tab.page))) closing.push(tab.page.close().catch(() => undefined));
      }
    }
    logger.info('[bots/computer] closed least recently used tabs', { count: closing.length });
    await Promise.all(closing);
  }

  // ─── internals ──────────────────────────────────────

  private browserCdp(): Promise<CDPSession> {
    this.cdp ??= this.browser.newBrowserCDPSession();
    return this.cdp;
  }

  /**
   * Dispose background contexts that cannot be live (ContextBook rules). The
   * DevTools relay keeps Chromium's pipe open across clients, so Chromium
   * never disposes them on its own, and Playwright would even report their
   * pages as belonging to the default context. Contexts of this registry's
   * live leases are never touched.
   */
  async sweepContexts(): Promise<number> {
    this.lastSweepAt = Date.now();
    const sweepForeign = this.foreignOwnerGone;
    this.foreignOwnerGone = false;
    try {
      const cdp = await this.browserCdp();
      const { browserContextIds } = (await cdp.send('Target.getBrowserContexts')) as { browserContextIds: string[] };
      this.book.retain(new Set(browserContextIds));
      let disposed = 0;
      for (const id of browserContextIds) {
        // Liveness is read per id, after every await: a background lease of
        // this registry may have recorded its context in the meantime.
        if (this.ownsLiveContext(id)) continue;
        if (!this.book.disposable(id) && !sweepForeign) continue;
        await cdp.send('Target.disposeBrowserContext', { browserContextId: id }).catch(() => undefined);
        this.book.forget(id);
        disposed++;
      }
      if (disposed > 0) logger.info('[bots/computer] disposed orphaned background contexts', { count: disposed });
      return disposed;
    } catch (err) {
      logger.warn('[bots/computer] context sweep failed', { error: toErrorMessage(err) });
      return 0;
    }
  }

  /**
   * No other process can own a context of this computer right now — e.g. this
   * process just claimed its DevTools connection from an owner that stopped
   * heart-beating. The next sweep (the first acquire's, when called before
   * it) disposes every context this registry does not hold, without waiting
   * out FOREIGN_CONTEXT_GRACE_MS.
   */
  expireForeign(): void {
    this.foreignOwnerGone = true;
  }

  private ownsLiveContext(contextId: string): boolean {
    for (const lease of this.leases.values()) if (lease.contextId === contextId) return true;
    return false;
  }

  /**
   * First use of a connection: inherit what earlier connections left.
   *
   * - Sweep background contexts that cannot be live (`sweepContexts`). Another
   *   API slot may be connected to this computer at the same time (blue/green
   *   switch, its Runtime worker running a task), so a context this process
   *   did not create is left alone until it is older than any task can run.
   * - Re-adopt every window tagged `gh-bot:<botId>:<sessionId>` into its lease.
   */
  private async takeOver(): Promise<void> {
    await this.sweepContexts();

    const context = this.defaultContext();
    const pages = context.pages().filter((p) => !p.isClosed());
    const names = await Promise.all(
      pages.map((p) =>
        withTimeout(
          p.evaluate(() => window.name),
          1_500,
        ).catch(() => ''),
      ),
    );
    let adopted = 0;
    for (const [i, page] of pages.entries()) {
      const match = TAG_PATTERN.exec(names[i] ?? '');
      if (!match) continue;
      const spec: LeaseSpec = { kind: 'foreground', botId: match[1]!, sessionId: match[2]! };
      let lease = this.leases.get(leaseKey(spec));
      if (!lease) {
        lease = new TabLease(spec, context, false);
        this.leases.set(lease.key, lease);
      }
      if (lease.tabs.length >= MAX_TABS_PER_LEASE) {
        await page.close().catch(() => undefined);
        continue;
      }
      this.attach(lease, page);
      lease.current = page;
      adopted++;
    }
    if (adopted > 0) logger.info('[bots/computer] re-adopted lease windows', { count: adopted });
  }

  private closeIdleBackgroundLeases(): void {
    const cutoff = Date.now() - BACKGROUND_IDLE_MS;
    for (const lease of this.leases.values()) {
      if (lease.spec.kind === 'background' && lease.lastUsedAt < cutoff) void this.release(lease.key);
    }
  }

  private async openLease(spec: LeaseSpec): Promise<TabLease> {
    await this.enforceCaps(null, 1, leaseKey(spec));
    if (spec.kind === 'background') {
      // A clean context per background turn: no cookies, so a read-only task
      // can never act as the signed-in member. A new context opens its own
      // window, which is exactly the isolation we want.
      const context = await this.browser.newContext({ viewport: null, acceptDownloads: false });
      const lease = new TabLease(spec, context, true);
      this.leases.set(lease.key, lease);
      const page = await context.newPage();
      this.attach(lease, page);
      lease.current = page;
      // Remember the context as ours, so a later connection of this process
      // disposes it at once and another process's sweep is the only grace.
      const info = await targetInfoOf(context, page);
      if (info?.browserContextId) {
        lease.contextId = info.browserContextId;
        this.book.addOwn(info.browserContextId);
      }
      return lease;
    }

    const context = this.defaultContext();
    const page = await this.openWindow(context);
    const lease = new TabLease(spec, context, false);
    this.leases.set(lease.key, lease);
    this.attach(lease, page);
    lease.current = page;
    await this.retag(lease, page);
    return lease;
  }

  /**
   * A page in a new window of the default context. `context.newPage()` would
   * open a tab in whatever window was last active, so ask Chromium for a new
   * window over CDP. The target is created on a unique `about:blank#…` URL so
   * its Page can be recognised by URL alone — asking every candidate page for
   * its target id costs a DevTools session (≈0.5 s) each.
   */
  private async openWindow(context: BrowserContext): Promise<Page> {
    const cdp = await this.browserCdp();
    const marker = `about:blank#gh-lease-${randomBytes(8).toString('hex')}`;
    const { targetId } = (await cdp.send('Target.createTarget', { url: marker, newWindow: true })) as {
      targetId: string;
    };
    const deadline = Date.now() + FIND_PAGE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const page = context.pages().find((p) => p.url() === marker);
      if (page) {
        targetIds.set(page, targetId);
        return page;
      }
      await sleep(15);
    }
    await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    throw new Error('The new browser window did not appear in time');
  }

  private attach(lease: TabLease, page: Page): void {
    this.owners.set(page, lease);
    lease.tabs.push({ page, lastUsedAt: Date.now() });
    if (this.instrumented.has(page)) return;
    this.instrumented.add(page);
    page.on('popup', (popup) => {
      const owner = this.owners.get(page);
      if (!owner || !this.leases.has(owner.key)) return;
      // A link the Bot clicked opened a new tab: continue there, like a person would.
      this.attach(owner, popup);
      owner.select(popup);
      void this.enforceCaps(owner, 0);
    });
    page.on('close', () => {
      const owner = this.owners.get(page);
      if (!owner) return;
      const index = owner.tabs.findIndex((t) => t.page === page);
      if (index >= 0) owner.tabs.splice(index, 1);
      if (owner.current === page) {
        const next = [...owner.tabs].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
        owner.current = next?.page ?? null;
      }
      if (owner.tabs.length === 0 && this.leases.get(owner.key) === owner) {
        this.leases.delete(owner.key);
        if (owner.ownsContext) {
          void owner.context.close().catch(() => undefined);
          if (owner.contextId) this.book.forget(owner.contextId);
        }
      }
    });
  }
}

const targetIds = new WeakMap<Page, string>();

/** A page's DevTools target id and browser context id (Playwright exposes neither). */
async function targetInfoOf(
  context: BrowserContext,
  page: Page,
): Promise<{ targetId: string; browserContextId?: string } | null> {
  let session: CDPSession | null = null;
  try {
    session = await context.newCDPSession(page);
    const { targetInfo } = (await session.send('Target.getTargetInfo')) as {
      targetInfo: { targetId: string; browserContextId?: string };
    };
    targetIds.set(page, targetInfo.targetId);
    return targetInfo;
  } catch {
    return null;
  } finally {
    await session?.detach().catch(() => undefined);
  }
}

/** The DevTools target id of a page (cached; Playwright does not expose it). */
export async function targetIdOf(context: BrowserContext, page: Page): Promise<string | null> {
  return targetIds.get(page) ?? (await targetInfoOf(context, page))?.targetId ?? null;
}

const registries = new WeakMap<Browser, LeaseRegistry>();

/** The lease registry of a browser connection. */
export function leaseRegistryFor(browser: Browser): LeaseRegistry {
  let registry = registries.get(browser);
  if (!registry) {
    registry = new LeaseRegistry(browser);
    registries.set(browser, registry);
  }
  return registry;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
