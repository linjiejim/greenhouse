/**
 * The Agent's browser: the Chromium in its computer, driven over DevTools (cdp.ts), one action
 * per connection. An action claims the screen first (the computer's lease): while the member
 * controls the screen the Agent does not act, and if they take it over mid-action the next step
 * stops and nothing read from the page is returned.
 *
 * Rules kept here, not in prompts:
 * - Only http(s) pages are opened or read; file:, chrome:, devtools:, javascript: and the like,
 *   and Greenhouse's own origins, are refused, and a page that ends up there is left.
 * - The current tab is the one showing on the screen, so the Agent and a member watching see
 *   the same page. Refs (`e12`) come from the turn's latest snapshot of that page.
 * - The Agent never types into a password or payment-card field: logins go through the vault.
 * - Everything read from a page passes through the member's vault redaction first, and the page
 *   scripts run in an isolated world the page's own scripts cannot reach.
 */

import { randomUUID } from 'node:crypto';
import type { SandboxClient } from '@greenhouse/providers';
import { toErrorMessage } from '@greenhouse/utils/error';
import { logger } from '@greenhouse/utils/logger';
import type { ComputersService } from './service.js';
import { CdpError, openCdp, type Cdp } from './cdp.js';
import { buildSnapshot, compactText, redactor, windowOf, type AxNode } from './snapshot.js';

const ACTION_LEASE_MS = 90_000;
const CLAIM_WAIT_MS = 20_000;
const MEMBER_GRACE_MS = 3_000;
/** A computer that just started needs a few seconds before its browser answers. */
const CONNECT_WAIT_MS = 30_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const SETTLE_MS = 8_000;
const WAIT_MAX_S = 30;
const SNAPSHOT_CHARS = 12_000;
const AFTER_ACTION_CHARS = 6_000;
const TEXT_CHARS = 8_000;
const MAX_TABS = 20;
/** The isolated world our page scripts run in. */
const WORLD = '__greenhouse';

/** Runs in our isolated world; a vault fill authorizes only that exact login form. */
export const SUBMIT_RISK = `function (submit) {
  const element = this.closest('button,input,a,[role="button"]') || this;
  const form = element.form || element.closest('form');
  const label = [element.textContent, element.getAttribute('aria-label'), element.getAttribute('value')].join(' ');
  const destructive = /send|pay|purchase|buy|delete|remove|publish|post|checkout|authorize|grant|授权|发送|支付|付款|购买|删除|发布|下单/i.test(label);
  const submitLabel = /submit|confirm|approve|accept|allow|提交|确认|同意|允许/i.test(label);
  const submits = submit || (element.tagName === 'BUTTON' && form && element.type !== 'button' && element.type !== 'reset') ||
    (element.tagName === 'INPUT' && /submit|image/i.test(element.type));
  const approved = globalThis.__greenhouseApprovedLoginForm;
  if (form && form === approved?.form && form.action === approved.action && form.method === approved.method && !destructive) return false;
  return !!(submits || submitLabel || destructive);
}`;

export type BrowserInput =
  | { action: 'open'; url: string; new_tab?: boolean }
  | { action: 'snapshot'; from_line?: number }
  | { action: 'read'; from_char?: number }
  | { action: 'click'; ref: string }
  | { action: 'type'; ref: string; text: string; submit?: boolean }
  | { action: 'press'; key: string }
  | { action: 'scroll'; direction?: 'up' | 'down'; ref?: string }
  | { action: 'wait'; text?: string; seconds?: number }
  | { action: 'back' }
  | { action: 'tabs' }
  | { action: 'switch_tab'; tab: number }
  | { action: 'close_tab'; tab?: number }
  | { action: 'screenshot' };

export interface BrowserCall {
  approved?: boolean;
  memberId: string;
  agentId: string;
  /** The turn: element refs belong to its run. */
  runId: string;
  signal?: AbortSignal;
  /** Shows a screenshot to a model that can see images; absent when it cannot. */
  attachImage?: (image: Uint8Array, mediaType: string) => void;
  saveScreenshot?: (image: Uint8Array, mediaType: string, check: () => Promise<void>) => Promise<string>;
}

export interface TabView {
  tab: number;
  title: string;
  url: string;
  current: boolean;
}

/** What the Agent reads back. Small: a window of the page, never all of it. */
export interface BrowserResult {
  url?: string;
  file_id?: string;
  title?: string;
  snapshot?: string;
  /** The snapshot holds more: `snapshot {from_line}` continues here. */
  next_line?: number;
  total_lines?: number;
  text?: string;
  next_char?: number;
  tabs?: TabView[];
  dialog?: string;
  note?: string;
  error?: string;
  code?: string;
}

/** A refusal the Agent is told about; never a crash. */
export class BrowserRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserRefusal';
  }
}

const MEMBER_IN_CONTROL =
  "The member is controlling your computer's screen right now, so the browser is theirs. If you need them to finish something there first, use request_takeover (you are woken when they hand it back); otherwise end your turn and say what you were about to do.";
export const TAKEN_OVER =
  'The member took over the screen during this action, so it stopped and nothing it read is kept. End your turn and say where you were, or use request_takeover to be woken when they hand it back.';

const BLOCKED_SCHEMES =
  /^(?:file|chrome|chrome-extension|chrome-untrusted|chrome-search|devtools|view-source|javascript|data|blob|filesystem|about|intent|ws|wss|ftp):/i;
/** Pages that may be read besides http(s): a blank tab, Chromium's own error page, the welcome page. */
const READABLE = /^(?:about:blank$|chrome-error:\/\/chromewebdata\/|file:\/\/\/opt\/greenhouse\/)/;
const REF = /^e\d{1,6}$/;

/** What the model typed as a page to open: a browsable URL, or why not. */
export function browsableUrl(raw: string, forbidden: readonly string[]): { url: string } | BrowserRefusal {
  const value = raw.trim();
  if (!value) return new BrowserRefusal('url_invalid', 'Give a URL to open.');
  if (value === 'about:blank') return { url: value };
  if (BLOCKED_SCHEMES.test(value))
    return new BrowserRefusal('url_forbidden', 'Only http and https pages can be opened.');
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return new BrowserRefusal('url_invalid', `"${value.slice(0, 200)}" is not a valid URL.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new BrowserRefusal('url_forbidden', 'Only http and https pages can be opened.');
  }
  if (parsed.username || parsed.password) {
    return new BrowserRefusal('url_forbidden', 'A URL never carries a login: sign in with the vault.');
  }
  if (forbidden.includes(parsed.origin)) {
    return new BrowserRefusal('url_forbidden', 'Greenhouse itself cannot be opened in your browser.');
  }
  return { url: parsed.href };
}

/** Whether the Agent may read a page at this address. */
export function readableUrl(url: string, forbidden: readonly string[]): boolean {
  if (READABLE.test(url)) return true;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !forbidden.includes(parsed.origin);
  } catch {
    return false;
  }
}

/** Greenhouse's own origins, from its public URL and the web origins it allows. */
export function ownOrigins(config: { PUBLIC_URL: string; corsAllowedOrigins: readonly string[] }): string[] {
  return [
    ...new Set(
      [config.PUBLIC_URL, ...config.corsAllowedOrigins].map(originOf).filter((origin): origin is string => !!origin),
    ),
  ];
}

/** The origin of an http(s) URL, or null. */
export function originOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.origin : null;
  } catch {
    return null;
  }
}

// ─── Keys ─────────────────────────────────────────────────

interface KeyDef {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
}

const NAMED_KEYS: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
const MODIFIERS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/** `Enter`, `a`, `Control+A`, `Shift+Tab`: the key and its modifier bits, or null. */
export function parseKey(raw: string): { def: KeyDef; modifiers: number } | null {
  const parts = raw.trim().split('+');
  if (!parts.length || parts.length > 4) return null;
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIERS[part];
    if (!bit) return null;
    modifiers |= bit;
  }
  const last = parts[parts.length - 1]!;
  let def = NAMED_KEYS[last];
  if (!def && /^[a-zA-Z]$/.test(last)) {
    const upper = last.toUpperCase();
    const shifted = (modifiers & MODIFIERS.Shift!) !== 0;
    const key = shifted ? upper : last.toLowerCase();
    def = { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: key };
  }
  if (!def && /^[0-9]$/.test(last)) def = { key: last, code: `Digit${last}`, keyCode: last.charCodeAt(0), text: last };
  if (!def && /^F([1-9]|1[0-2])$/.test(last)) {
    def = { key: last, code: last, keyCode: 111 + Number(last.slice(1)) };
  }
  if (!def) return null;
  // A shortcut types nothing.
  if (modifiers & (MODIFIERS.Control! | MODIFIERS.Alt! | MODIFIERS.Meta!)) def = { ...def, text: undefined };
  return { def, modifiers };
}

/** A key as a person presses it on the focused element: down (typing its text, if any), then up. */
export async function pressKey(page: Page, def: KeyDef = NAMED_KEYS.Enter!, modifiers = 0): Promise<void> {
  const base = {
    key: def.key,
    code: def.code,
    windowsVirtualKeyCode: def.keyCode,
    nativeVirtualKeyCode: def.keyCode,
    modifiers,
  };
  await page.send('Input.dispatchKeyEvent', {
    ...base,
    type: def.text ? 'keyDown' : 'rawKeyDown',
    ...(def.text ? { text: def.text, unmodifiedText: def.text } : {}),
  });
  await page.send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

// ─── In-page scripts (isolated world; never given a secret) ─────

const VISIBLE_TEXT = `(() => {
  const body = document.body;
  return body ? body.innerText : '';
})()`;

/** Chooses the option of a list whose text (or value) is the one given, as a person picking it would. */
const CHOOSE_OPTION = `function (wanted) {
  const text = String(wanted).trim().toLowerCase();
  const options = Array.from(this.options || []);
  const option =
    options.find((entry) => entry.label.trim().toLowerCase() === text || entry.value.toLowerCase() === text) ||
    options.find((entry) => entry.label.trim().toLowerCase().includes(text));
  if (!option || option.disabled) return false;
  this.value = option.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

/** Text a screenshot could show: visible text and the values of fields that are not masked. */
const SHOWN_TEXT = `(() => {
  const parts = [document.title, document.body ? document.body.innerText : ''];
  for (const field of document.querySelectorAll('input, textarea')) {
    if ((field.getAttribute('type') || '').toLowerCase() !== 'password') parts.push(field.value || '');
  }
  return parts.join('\\n').slice(0, 2000000);
})()`;

export interface Frame {
  frameId: string;
  loaderId: string;
  url: string;
  origin: string | null;
}

/** One attached tab within an action. */
export interface Page {
  cdp: Cdp;
  sessionId: string;
  targetId: string;
  send<T = Record<string, any>>(method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<T>;
  /** The main frame as the browser reports it: never what the page says about itself. */
  frame(): Promise<Frame>;
  /** The isolated world of the current document: our scripts' globals, out of the page's reach. */
  world(): Promise<number>;
  /** A script in the isolated world. */
  run<T>(expression: string, timeoutMs?: number): Promise<T>;
  /** Waits for the page to finish loading, up to `ms`. */
  settle(ms?: number): Promise<void>;
  /** The member has not taken the screen since the action began. */
  stillOurs(): Promise<boolean>;
  /** Messages of dialogs the page opened (dismissed), already redacted. */
  dialogs: string[];
}

interface RefMap {
  targetId: string;
  loaderId: string;
  refs: Map<string, number>;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new BrowserRefusal('stopped', 'Stopped.'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new BrowserRefusal('stopped', 'Stopped.'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

export function createBrowserService(deps: {
  computers: ComputersService;
  /** Values no model may read: the member's vault secrets. */
  secrets(memberId: string): Promise<string[]>;
  /** Greenhouse's own origins: never opened in a computer. */
  forbiddenOrigins: readonly string[];
}) {
  /** The latest snapshot's refs per run, a few hundred runs at most. */
  const refMaps = new Map<string, RefMap>();
  /** Tabs in the order this process first saw them, so tab numbers stay put between calls. */
  const tabOrder = new Map<string, string[]>();
  /** Values the vault just typed that are not stored (one-time codes): hidden for a while too. */
  const typed = new Map<string, Array<{ value: string; until: number }>>();

  function rememberRefs(runId: string, map: RefMap) {
    refMaps.delete(runId);
    refMaps.set(runId, map);
    if (refMaps.size > 300) refMaps.delete(refMaps.keys().next().value!);
  }

  async function redactionFor(memberId: string): Promise<(text: string) => string> {
    const now = Date.now();
    const recent = (typed.get(memberId) ?? []).filter((entry) => entry.until > now);
    if (recent.length) typed.set(memberId, recent);
    else typed.delete(memberId);
    return redactor([...(await deps.secrets(memberId)), ...recent.map((entry) => entry.value)]);
  }

  /** Claims the screen for one action: false when an approved fill goes ahead under the member's control. */
  async function claim(computerId: string, holder: string, approved: boolean, signal?: AbortSignal) {
    const deadline = Date.now() + CLAIM_WAIT_MS;
    // A member who just handed back may still be closing their screen.
    const memberGrace = Date.now() + MEMBER_GRACE_MS;
    for (;;) {
      const outcome = await deps.computers.claimScreen(computerId, holder, 'agent', ACTION_LEASE_MS);
      if (outcome === 'claimed') return true;
      if (outcome === 'member') {
        if (approved) return false;
        if (Date.now() > memberGrace) throw new BrowserRefusal('member_in_control', MEMBER_IN_CONTROL);
      } else if (Date.now() > deadline) {
        throw new BrowserRefusal('browser_busy', 'Your browser is busy with another action. Try again in a moment.');
      }
      await sleep(250, signal);
    }
  }

  async function connect(client: SandboxClient, name: string, signal?: AbortSignal): Promise<Cdp> {
    const deadline = Date.now() + CONNECT_WAIT_MS;
    for (;;) {
      const cdp = openCdp(client.devtools(name), { ...(signal ? { signal } : {}) });
      try {
        await cdp.send('Target.getTargets', {}, { timeoutMs: 5_000 });
        return cdp;
      } catch {
        cdp.close();
        if (signal?.aborted) throw new BrowserRefusal('stopped', 'Stopped.');
        if (Date.now() > deadline) {
          throw new BrowserRefusal(
            'browser_unavailable',
            'The browser in your computer is not answering. Try again in a minute, or restart the computer.',
          );
        }
        await sleep(1_000, signal);
      }
    }
  }

  interface Tab {
    targetId: string;
    url: string;
    title: string;
  }

  async function listTabs(cdp: Cdp, computerId: string): Promise<Tab[]> {
    const { targetInfos } = await cdp.send<{
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    }>('Target.getTargets');
    const pages = targetInfos.filter((info) => info.type === 'page' && !info.url.startsWith('devtools://'));
    const known = (tabOrder.get(computerId) ?? []).filter((id) => pages.some((page) => page.targetId === id));
    for (const page of pages) if (!known.includes(page.targetId)) known.push(page.targetId);
    tabOrder.set(computerId, known);
    return known.map((id) => {
      const page = pages.find((entry) => entry.targetId === id)!;
      return { targetId: id, url: page.url, title: page.title };
    });
  }

  /**
   * One action on the member's computer of this Agent: the screen claimed, a fresh DevTools
   * connection, released afterwards whatever happens.
   */
  async function session<T>(
    memberId: string,
    agentId: string,
    options: { approved?: boolean; signal?: AbortSignal },
    work: (ctx: {
      cdp: Cdp;
      computerId: string;
      redact: (text: string) => string;
      stillOurs: () => Promise<boolean>;
      tabs: () => Promise<Tab[]>;
      attach: (tab: Tab) => Promise<Page>;
      current: () => Promise<Page | null>;
    }) => Promise<T>,
  ): Promise<T> {
    const { row, client } = await deps.computers.ensure(memberId, agentId);
    if (row.backgroundRunId)
      throw new BrowserRefusal('computer_background_busy', 'Background work is using this computer.');
    const holder = `act_${randomUUID()}`;
    const claimed = await claim(row.id, holder, options.approved === true, options.signal);
    const stillOurs = async () => !claimed || (await deps.computers.holdsScreen(row.id, holder));
    let cdp: Cdp | null = null;
    try {
      const redact = await redactionFor(memberId);
      cdp = await connect(client, row.sandboxRef, options.signal);
      const attached = new Map<string, Page>();
      const live = cdp;
      const attach = async (tab: Tab): Promise<Page> => {
        const known = attached.get(tab.targetId);
        if (known) return known;
        const { sessionId } = await live.send<{ sessionId: string }>('Target.attachToTarget', {
          targetId: tab.targetId,
          flatten: true,
        });
        const page = makePage(live, sessionId, tab.targetId, redact, stillOurs, options.signal);
        await page.send('Page.enable').catch(() => undefined);
        attached.set(tab.targetId, page);
        return page;
      };
      const current = async (): Promise<Page | null> => {
        const tabs = await listTabs(live, row.id);
        if (!tabs.length) return null;
        // The tab on the screen: the one whose document is visible.
        for (const tab of tabs.slice().reverse()) {
          const page = await attach(tab);
          const state = await page.run<string>('document.visibilityState', 3_000).catch(() => '');
          if (state === 'visible') return page;
        }
        return attach(tabs[tabs.length - 1]!);
      };
      return await work({
        cdp: live,
        computerId: row.id,
        redact,
        stillOurs,
        tabs: () => listTabs(live, row.id),
        attach,
        current,
      });
    } finally {
      cdp?.close();
      if (claimed) {
        await deps.computers
          .releaseScreen(row.id, holder)
          .catch((error: unknown) =>
            logger.warn('[browser] could not release the screen', { computer: row.id, error: toErrorMessage(error) }),
          );
      }
      await deps.computers.touch(row.id).catch(() => undefined);
    }
  }

  function makePage(
    cdp: Cdp,
    sessionId: string,
    targetId: string,
    redact: (text: string) => string,
    stillOurs: () => Promise<boolean>,
    signal?: AbortSignal,
  ): Page {
    let context: { id: number; loaderId: string } | null = null;
    const dialogs: string[] = [];
    // A dialog blocks the page's scripts until answered: dismiss it, and tell the Agent what it said.
    cdp.on((event) => {
      if (event.sessionId !== sessionId || event.method !== 'Page.javascriptDialogOpening') return;
      const type = String(event.params.type ?? '');
      dialogs.push(redact(String(event.params.message ?? '')).slice(0, 300));
      void cdp
        .send('Page.handleJavaScriptDialog', { accept: type === 'alert' || type === 'beforeunload' }, { sessionId })
        .catch(() => undefined);
    });
    const send = <T>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number) =>
      cdp.send<T>(method, params, { sessionId, ...(timeoutMs ? { timeoutMs } : {}) });
    const frame = async (): Promise<Frame> => {
      const { frameTree } = await send<{
        frameTree: { frame: { id: string; loaderId: string; url: string; urlFragment?: string } };
      }>('Page.getFrameTree');
      const main = frameTree.frame;
      return { frameId: main.id, loaderId: main.loaderId, url: main.url, origin: originOf(main.url) };
    };
    const world = async (): Promise<number> => {
      const main = await frame();
      if (!context || context.loaderId !== main.loaderId) {
        const created = await send<{ executionContextId: number }>('Page.createIsolatedWorld', {
          frameId: main.frameId,
          worldName: WORLD,
          grantUniveralAccess: false,
        });
        context = { id: created.executionContextId, loaderId: main.loaderId };
      }
      return context.id;
    };
    const page: Page = {
      cdp,
      sessionId,
      targetId,
      dialogs,
      send,
      frame,
      world,
      async run<T>(expression: string, timeoutMs?: number): Promise<T> {
        for (let attempt = 0; ; attempt++) {
          const contextId = await world();
          try {
            const result = await send<{ result?: { value?: unknown }; exceptionDetails?: unknown }>(
              'Runtime.evaluate',
              { expression, contextId, returnByValue: true, awaitPromise: true },
              timeoutMs,
            );
            if (result.exceptionDetails) throw new CdpError('Runtime.evaluate', 'The page script failed.');
            return result.result?.value as T;
          } catch (error) {
            // The page navigated under the script: its world is gone; make a new one once.
            context = null;
            if (attempt >= 1 || !(error instanceof CdpError) || !/context|destroyed|navigat/i.test(error.message)) {
              throw error;
            }
          }
        }
      },
      async settle(ms = SETTLE_MS) {
        await sleep(150, signal);
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const state = await page.run<string>('document.readyState', 3_000).catch(() => null);
          if (state === 'complete') return;
          await sleep(200, signal);
        }
      },
      stillOurs,
    };
    return page;
  }

  /** The page as lines with refs; the refs are kept for this run. */
  async function snapshotOf(page: Page, runId: string, redact: (text: string) => string) {
    const { nodes } = await page.send<{ nodes: AxNode[] }>('Accessibility.getFullAXTree', {}, 20_000);
    const built = buildSnapshot(nodes, redact);
    const main = await page.frame();
    rememberRefs(runId, { targetId: page.targetId, loaderId: main.loaderId, refs: built.refs });
    return built.lines;
  }

  /** A ref of this run's latest snapshot, on the page it was taken of. */
  async function nodeOf(page: Page, runId: string, ref: string): Promise<number> {
    if (!REF.test(ref))
      throw new BrowserRefusal('ref_invalid', 'Give the ref of an element from your latest snapshot, like e12.');
    const map = refMaps.get(runId);
    if (!map) throw new BrowserRefusal('ref_stale', 'Take a snapshot first; refs come from it.');
    if (map.targetId !== page.targetId || map.loaderId !== (await page.frame()).loaderId) {
      throw new BrowserRefusal('ref_stale', 'The page changed since your last snapshot. Take a new one.');
    }
    const node = map.refs.get(ref);
    if (node === undefined) throw new BrowserRefusal('ref_invalid', `There is no ${ref} in your latest snapshot.`);
    return node;
  }

  /** Leaves a page the Agent may not read, before anything is read from it. */
  async function guard(page: Page): Promise<Frame> {
    const main = await page.frame();
    if (readableUrl(main.url, deps.forbiddenOrigins)) return main;
    await page.send('Page.navigate', { url: 'about:blank' }).catch(() => undefined);
    throw new BrowserRefusal(
      'url_forbidden',
      'That page cannot be read by Agents (only http and https sites, and not Greenhouse itself). The tab was taken back to a blank page.',
    );
  }

  async function observe(
    page: Page,
    runId: string,
    redact: (text: string) => string,
    options: { snapshot?: { fromLine: number; maxChars: number } } = {},
  ): Promise<BrowserResult> {
    const main = await guard(page);
    const info = await page.cdp
      .send<{ targetInfo: { title: string } }>('Target.getTargetInfo', { targetId: page.targetId })
      .catch(() => ({ targetInfo: { title: '' } }));
    const result: BrowserResult = { url: redact(main.url), title: redact(info.targetInfo.title).slice(0, 200) };
    if (options.snapshot) {
      const lines = await snapshotOf(page, runId, redact);
      const window = windowOf(lines, options.snapshot.fromLine, options.snapshot.maxChars);
      result.snapshot = window.text || '(nothing readable on this page yet)';
      if (window.next) {
        result.next_line = window.next;
        result.total_lines = window.total;
      }
    }
    if (page.dialogs.length) result.dialog = page.dialogs.join(' | ');
    return result;
  }

  async function clickAt(page: Page, node: number) {
    await page.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node }).catch(() => undefined);
    const { quads } = await page.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: node });
    const quad = quads[0];
    if (!quad || quad.length < 8) throw new BrowserRefusal('not_clickable', 'That element is not on the screen.');
    const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4;
    const y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }

  /**
   * What typing into a node means: a list chooses an option; passwords and payment cards are
   * never typed by the Agent (they go through the vault or the member).
   */
  async function fieldKind(page: Page, node: number): Promise<'password' | 'card' | 'select' | 'text'> {
    const described = await page
      .send<{ node: { nodeName?: string; attributes?: string[] } }>('DOM.describeNode', { backendNodeId: node })
      .catch(() => null);
    const attributes = described?.node.attributes ?? [];
    const attribute = (name: string) => {
      const index = attributes.findIndex((entry, at) => at % 2 === 0 && entry.toLowerCase() === name);
      return index >= 0 ? (attributes[index + 1] ?? '').toLowerCase() : '';
    };
    if (attribute('type') === 'password' || /current-password|new-password/.test(attribute('autocomplete'))) {
      return 'password';
    }
    if (/cc-number|cc-csc|cc-exp/.test(attribute('autocomplete'))) return 'card';
    return described?.node.nodeName?.toUpperCase() === 'SELECT' ? 'select' : 'text';
  }

  async function submitRisk(page: Page, runId: string, input: BrowserInput): Promise<boolean> {
    const pressing = input.action === 'press' && /(?:Enter|Return|Space| )$/i.test(input.key);
    if (input.action !== 'click' && !(input.action === 'type' && input.submit) && !pressing) return false;
    const object =
      input.action === 'click' || input.action === 'type'
        ? (
            await page.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
              backendNodeId: await nodeOf(page, runId, input.ref),
              executionContextId: await page.world(),
            })
          ).object
        : (
            await page.send<{ result: { objectId?: string } }>('Runtime.evaluate', {
              expression: 'document.activeElement',
              contextId: await page.world(),
            })
          ).result;
    await guard(page);
    if (!object.objectId) return true;
    const result = await page.send<{ result: { value?: unknown } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: SUBMIT_RISK,
      arguments: [{ value: input.action === 'type' || (pressing && /Enter|Return/i.test(input.key)) }],
      returnByValue: true,
    });
    return result.result.value !== false;
  }

  /** Everything after an action that changes the page: guards, takes it back if taken over, observes. */
  async function after(
    page: Page,
    runId: string,
    redact: (text: string) => string,
    note?: string,
  ): Promise<BrowserResult> {
    if (!(await page.stillOurs())) throw new BrowserRefusal('member_in_control', TAKEN_OVER);
    const result = await observe(page, runId, redact, { snapshot: { fromLine: 1, maxChars: AFTER_ACTION_CHARS } });
    if (!(await page.stillOurs())) throw new BrowserRefusal('member_in_control', TAKEN_OVER);
    return note ? { ...result, note } : result;
  }

  async function perform(call: BrowserCall, input: BrowserInput): Promise<BrowserResult> {
    // A bad address is refused before the computer is even reached.
    const target = input.action === 'open' ? browsableUrl(input.url, deps.forbiddenOrigins) : null;
    if (target instanceof BrowserRefusal) throw target;
    return session(call.memberId, call.agentId, { ...(call.signal ? { signal: call.signal } : {}) }, async (ctx) => {
      const { redact } = ctx;
      const step = async () => {
        if (call.signal?.aborted) throw new BrowserRefusal('stopped', 'Stopped.');
        if (!(await ctx.stillOurs())) throw new BrowserRefusal('member_in_control', TAKEN_OVER);
      };
      const tabsView = async (currentId: string | null): Promise<TabView[]> =>
        (await ctx.tabs()).slice(0, MAX_TABS).map((tab, index) => ({
          tab: index + 1,
          title: redact(tab.title).slice(0, 120),
          url: readableUrl(tab.url, deps.forbiddenOrigins) ? redact(tab.url).slice(0, 300) : '(not readable)',
          current: tab.targetId === currentId,
        }));

      if (input.action === 'open' && (input.new_tab || !(await ctx.tabs()).length)) {
        await step();
        const { targetId } = await ctx.cdp.send<{ targetId: string }>('Target.createTarget', {
          url: (target as { url: string }).url,
        });
        await ctx.cdp.send('Target.activateTarget', { targetId }).catch(() => undefined);
        const page = await ctx.attach({ targetId, url: '', title: '' });
        await page.settle(NAVIGATION_TIMEOUT_MS / 2);
        return after(page, call.runId, redact, 'Opened in a new tab.');
      }

      const page = await ctx.current();
      if (input.action === 'tabs') return { tabs: await tabsView(page?.targetId ?? null) };
      if (!page) return { note: 'No tab is open. Use open {url}.' };

      if (!call.approved && (await submitRisk(page, call.runId, input)))
        throw new BrowserRefusal(
          'approval_required',
          'Submitting, sending, paying, deleting or publishing needs the member’s approval.',
        );

      switch (input.action) {
        case 'open': {
          await step();
          const navigated = await page.send<{ errorText?: string }>(
            'Page.navigate',
            { url: (target as { url: string }).url },
            NAVIGATION_TIMEOUT_MS,
          );
          await page.settle(NAVIGATION_TIMEOUT_MS / 2);
          const result = await after(page, call.runId, redact);
          return navigated.errorText
            ? { ...result, error: `The page did not load: ${navigated.errorText}`, code: 'navigation_failed' }
            : result;
        }
        case 'snapshot': {
          const result = await observe(page, call.runId, redact, {
            snapshot: { fromLine: input.from_line ?? 1, maxChars: SNAPSHOT_CHARS },
          });
          await step();
          return result;
        }
        case 'read': {
          const main = await guard(page);
          const text = compactText(redact((await page.run<string>(VISIBLE_TEXT, 10_000)) ?? ''));
          const from = Math.max(input.from_char ?? 0, 0);
          const slice = text.slice(from, from + TEXT_CHARS);
          await step();
          return {
            url: redact(main.url),
            text: slice || '(no text on this page)',
            ...(from + TEXT_CHARS < text.length ? { next_char: from + TEXT_CHARS } : {}),
          };
        }
        case 'click': {
          const node = await nodeOf(page, call.runId, input.ref);
          const before = new Set((await ctx.tabs()).map((tab) => tab.targetId));
          await step();
          await clickAt(page, node);
          await page.settle();
          // A link that opened a new tab: follow it there.
          const opened = (await ctx.tabs()).find((tab) => !before.has(tab.targetId));
          if (opened) {
            await ctx.cdp.send('Target.activateTarget', { targetId: opened.targetId }).catch(() => undefined);
            const next = await ctx.attach(opened);
            await next.settle();
            return after(next, call.runId, redact, 'It opened in a new tab, which is now the current one.');
          }
          return after(page, call.runId, redact);
        }
        case 'type': {
          const node = await nodeOf(page, call.runId, input.ref);
          const kind = await fieldKind(page, node);
          if (kind === 'password') {
            throw new BrowserRefusal(
              'secret_field',
              'That is a password field. Never type passwords yourself: use the vault, or ask the member to take over.',
            );
          }
          if (kind === 'card') {
            throw new BrowserRefusal(
              'secret_field',
              'That is a payment card field. Ask the member to take over for payments.',
            );
          }
          await step();
          const { object } = await page.send<{ object: { objectId?: string } }>('DOM.resolveNode', {
            backendNodeId: node,
            executionContextId: await page.world(),
          });
          if (kind === 'select') {
            const chosen = await page.send<{ result?: { value?: unknown } }>('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: CHOOSE_OPTION,
              arguments: [{ value: input.text }],
              returnByValue: true,
            });
            if (chosen.result?.value !== true) {
              throw new BrowserRefusal(
                'option_not_found',
                `No option of that list matches "${redact(input.text).slice(0, 80)}"; its options are in the snapshot.`,
              );
            }
            return after(page, call.runId, redact);
          }
          await page.send('DOM.focus', { backendNodeId: node });
          // Replace what the field holds, as a person selecting all and typing would.
          if (object.objectId) {
            await page.send('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration:
                'function () { if (typeof this.select === "function") { this.select(); return; } const range = document.createRange(); range.selectNodeContents(this); const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); }',
            });
          }
          await page.send('Input.insertText', { text: input.text });
          if (input.submit) {
            await step();
            await pressKey(page);
            await page.settle();
          }
          return after(page, call.runId, redact);
        }
        case 'press': {
          const key = parseKey(input.key);
          if (!key)
            throw new BrowserRefusal(
              'key_invalid',
              'Press a key such as Enter, Tab, Escape, ArrowDown, a or Control+A.',
            );
          await step();
          await pressKey(page, key.def, key.modifiers);
          await page.settle(key.def.key === 'Enter' ? SETTLE_MS : 1_500);
          return after(page, call.runId, redact);
        }
        case 'scroll': {
          await step();
          if (input.ref) {
            const node = await nodeOf(page, call.runId, input.ref);
            await page.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: node });
          } else {
            const metrics = await page.send<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
              'Page.getLayoutMetrics',
            );
            const width = metrics.cssVisualViewport?.clientWidth ?? 1280;
            const height = metrics.cssVisualViewport?.clientHeight ?? 800;
            await page.send('Input.dispatchMouseEvent', {
              type: 'mouseWheel',
              x: Math.round(width / 2),
              y: Math.round(height / 2),
              deltaX: 0,
              deltaY: Math.round(height * 0.8) * (input.direction === 'up' ? -1 : 1),
            });
          }
          await sleep(400, call.signal);
          const main = await guard(page);
          await step();
          return {
            url: redact(main.url),
            note: 'Scrolled. A snapshot holds the whole page wherever it is scrolled, including what scrolling loaded.',
          };
        }
        case 'wait': {
          const seconds = Math.min(Math.max(Math.round(input.seconds ?? (input.text ? 10 : 3)), 1), WAIT_MAX_S);
          if (input.text) {
            const deadline = Date.now() + seconds * 1000;
            const probe = `(() => !!document.body && document.body.innerText.includes(${JSON.stringify(input.text)}))()`;
            let seen = false;
            while (!seen && Date.now() < deadline) {
              seen = (await page.run<boolean>(probe, 5_000).catch(() => false)) === true;
              if (!seen) await sleep(500, call.signal);
            }
            const result = await after(page, call.runId, redact);
            return seen
              ? result
              : {
                  ...result,
                  error: `"${input.text.slice(0, 80)}" did not appear within ${seconds} s.`,
                  code: 'wait_timeout',
                };
          }
          await sleep(seconds * 1000, call.signal);
          return after(page, call.runId, redact);
        }
        case 'back': {
          const history = await page.send<{ currentIndex: number; entries: Array<{ id: number }> }>(
            'Page.getNavigationHistory',
          );
          const previous = history.entries[history.currentIndex - 1];
          if (!previous)
            return {
              ...(await after(page, call.runId, redact)),
              error: 'There is no earlier page in this tab.',
              code: 'no_history',
            };
          await step();
          await page.send('Page.navigateToHistoryEntry', { entryId: previous.id });
          await page.settle();
          return after(page, call.runId, redact);
        }
        case 'switch_tab':
        case 'close_tab': {
          const tabs = await ctx.tabs();
          const chosen =
            input.action === 'switch_tab'
              ? tabs[input.tab - 1]
              : input.tab
                ? tabs[input.tab - 1]
                : tabs.find((tab) => tab.targetId === page.targetId);
          if (!chosen) throw new BrowserRefusal('tab_invalid', 'There is no such tab. List them with tabs.');
          await step();
          if (input.action === 'switch_tab') {
            await ctx.cdp.send('Target.activateTarget', { targetId: chosen.targetId });
            return after(await ctx.attach(chosen), call.runId, redact);
          }
          // The last tab is emptied rather than closed: closing it would close the browser.
          if (tabs.length === 1) {
            const only = await ctx.attach(chosen);
            await only.send('Page.navigate', { url: 'about:blank' });
            return {
              tabs: await tabsView(chosen.targetId),
              note: 'That was the only tab, so it now shows a blank page.',
            };
          }
          await ctx.cdp.send('Target.closeTarget', { targetId: chosen.targetId });
          const next = await ctx.current();
          return { tabs: await tabsView(next?.targetId ?? null), note: 'Closed.' };
        }
        case 'screenshot': {
          const main = await guard(page);
          // A picture cannot be redacted: none is taken while the page shows a saved secret.
          const shown = await page.run<string>(SHOWN_TEXT, 10_000).catch(() => null);
          if (shown === null || redact(shown) !== shown) {
            throw new BrowserRefusal(
              'secret_visible',
              'This page shows a saved password or code in plain text, so no screenshot is taken. Use snapshot instead.',
            );
          }
          const { data } = await page.send<{ data: string }>(
            'Page.captureScreenshot',
            { format: 'jpeg', quality: 70 },
            20_000,
          );
          // Nothing taken across a take-over is kept.
          await step();
          const image = Buffer.from(data, 'base64');
          const fileId = await call.saveScreenshot?.(image, 'image/jpeg', step);
          call.attachImage?.(image, 'image/jpeg');
          return {
            url: redact(main.url),
            ...(fileId ? { file_id: fileId } : {}),
            note: call.attachImage
              ? 'The member can see the screenshot attached to your reply. It is also shown to you with this result. Do not duplicate it in Markdown.'
              : 'The member can see the screenshot attached to your reply, but your model cannot see images. Do not claim you inspected it or duplicate it in Markdown. Use snapshot (accessibility tree) or read (page text) to decide what to do next.',
          };
        }
      }
    });
  }

  const service = {
    async needsApproval(call: BrowserCall, input: BrowserInput): Promise<boolean> {
      if (
        input.action !== 'click' &&
        !(input.action === 'type' && input.submit) &&
        !(input.action === 'press' && /Enter|Return|Space| $/i.test(input.key))
      )
        return false;
      return session(call.memberId, call.agentId, { signal: call.signal }, async (ctx) => {
        const page = await ctx.current();
        if (!page) return true;
        return submitRisk(page, call.runId, input).catch((error: unknown) => {
          if (error instanceof BrowserRefusal) return false;
          throw error;
        });
      });
    },
    /**
     * One browser action for the Agent's turn. Refusals and failures come back as `error` and
     * `code` with what to do next; their text is redacted like everything read from a page.
     */
    async act(call: BrowserCall, input: BrowserInput): Promise<BrowserResult> {
      try {
        return await perform(call, input);
      } catch (error) {
        if (error instanceof BrowserRefusal) return { error: error.message, code: error.code };
        if (call.signal?.aborted) return { error: 'Stopped.', code: 'stopped' };
        const redact = await redactionFor(call.memberId).catch(() => (text: string) => text.replace(/./g, '*'));
        const message = redact(error instanceof CdpError ? `${error.method}: ${error.message}` : toErrorMessage(error));
        // Known API errors (no computer, computers off) keep their own words.
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          typeof (error as { code: unknown }).code === 'string'
        ) {
          return { error: message.slice(0, 300), code: (error as { code: string }).code };
        }
        logger.warn('[browser] an action failed', { action: input.action, error: message.slice(0, 300) });
        return { error: `The browser action failed: ${message.slice(0, 300)}`, code: 'failed' };
      }
    },

    /**
     * Runs `work` on the tab showing on the member's computer of this Agent, under the screen
     * lease (the vault's fills). `approved`: the member approved this very action, so it goes
     * ahead while they control the screen.
     */
    async withPage<T>(
      memberId: string,
      agentId: string,
      options: { approved?: boolean; signal?: AbortSignal },
      work: (page: Page) => Promise<T>,
    ): Promise<T> {
      return session(memberId, agentId, options, async (ctx) => {
        const page = await ctx.current();
        if (!page) throw new BrowserRefusal('no_tab', 'No tab is open in the browser.');
        return work(page);
      });
    },

    /** Hides a value the vault just typed (a one-time code) from what the browser reads, for a while. */
    remember(memberId: string, value: string, ms = 10 * 60_000) {
      const list = typed.get(memberId) ?? [];
      list.push({ value, until: Date.now() + ms });
      typed.set(memberId, list.slice(-20));
    },
  };
  return service;
}

export type BrowserService = ReturnType<typeof createBrowserService>;
