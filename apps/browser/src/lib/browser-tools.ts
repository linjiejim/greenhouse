/**
 * Browser automation executors — run agent-requested browser actions locally.
 *
 * The chat stream delivers a `local-tool-request` for one of the actions
 * declared in browser-actions.ts; executeBrowserAction() performs it with
 * chrome.tabs / chrome.scripting and the caller posts the result back to
 * /api/client-tools/result, resuming the paused agent step.
 *
 * Design notes:
 * - No resident content script: element indexing and interactions are one-shot
 *   chrome.scripting.executeScript(func) injections. The indexer pins the live
 *   element list on `window.__ghAgentElements` (isolated world, persists per
 *   page load) so a later click/type can resolve the same node; any navigation
 *   drops the global and the executor reports a stale-index error the model
 *   can recover from by re-listing.
 * - Element-list + interaction approach inspired by nanobrowser's buildDomTree
 *   (Apache-2.0); this is an independent, much smaller implementation (top
 *   frame only, no iframe/shadow-DOM piercing — documented limitation).
 * - CONFIRM_ACTIONS (click/type) call the injected highlighter first (outline
 *   flash on the target) and then await the panel's confirm gate; a decline
 *   returns `{ error }` so the agent sees the refusal and can adapt.
 */

import { CONFIRM_ACTIONS } from './browser-actions';
import { isSensitiveHost, hostOf as hostFromUrl, type ActionSignals } from './automation-prefs';

const READ_PAGE_LIMIT = 15_000;
const MAX_ELEMENTS = 120;
const MAX_TABS = 40;
const LOAD_TIMEOUT_MS = 15_000;

export interface ConfirmRequest {
  toolId: string;
  /** Text/label of the target element (for the confirm card). */
  targetText?: string;
  /** Text the agent wants to type (browser_type only). */
  inputText?: string;
  /** URL of the page the action runs on. */
  pageUrl?: string;
  /** Danger signals used by the panel's permission policy (Auto mode). */
  signals: ActionSignals;
}

/**
 * Panel-provided gate: given the action + its danger signals, resolve true to
 * allow, false to decline. The panel applies the Ask/Auto/YOLO policy here —
 * this module just gathers the signals and asks.
 */
export type ConfirmFn = (req: ConfirmRequest) => Promise<boolean>;

export type ActionResult = { output: unknown } | { error: string };

/** Pages the extension can never script (browser UI, web stores, extension pages). */
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return true;
  return /^(chrome|chrome-extension|edge|about|devtools):/.test(url) || url.startsWith('https://chromewebstore.');
}

// ─── Injected functions (serialized by chrome.scripting — must be self-contained) ───

function collectElementsInPage(limit: number) {
  const SELECTOR =
    'a[href], button, input, select, textarea, summary, ' +
    '[role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], ' +
    '[role="checkbox"], [role="radio"], [role="combobox"], [role="searchbox"], [role="textbox"], ' +
    '[contenteditable="true"], [onclick]';
  const kept: Element[] = [];
  const items: Array<Record<string, unknown>> = [];
  const nodes = document.querySelectorAll(SELECTOR);
  for (const el of Array.from(nodes)) {
    if (items.length >= limit) break;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
    const he = el as HTMLElement;
    const input = el as HTMLInputElement;
    const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || he.isContentEditable;
    const text = (he.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 100);
    const label = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '')
      .trim()
      .slice(0, 100);
    if (!text && !label && !isField) continue;
    const item: Record<string, unknown> = { index: kept.length, tag: el.tagName.toLowerCase() };
    if (text) item.text = text;
    if (label && label !== text) item.label = label;
    const role = el.getAttribute('role');
    if (role) item.role = role;
    if (el.tagName === 'A') item.href = ((el as HTMLAnchorElement).href || '').slice(0, 300);
    if (el.tagName === 'INPUT') {
      item.input_type = input.type;
      if (input.checked) item.checked = true;
    }
    if (isField && typeof input.value === 'string' && input.value) item.value = input.value.slice(0, 100);
    if ((el as HTMLButtonElement).disabled) item.disabled = true;
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) item.offscreen = true;
    kept.push(el);
    items.push(item);
  }
  (window as unknown as Record<string, unknown>).__ghAgentElements = kept;
  return {
    url: location.href,
    title: document.title,
    scroll_y: Math.round(window.scrollY),
    page_height: Math.round(document.documentElement.scrollHeight),
    viewport_height: window.innerHeight,
    truncated: items.length >= limit,
    elements: items,
  };
}

function readPageInPage(limit: number) {
  const text = (document.body?.innerText ?? '').replace(/\n{3,}/g, '\n\n').trim();
  return {
    url: location.href,
    title: document.title,
    scroll_y: Math.round(window.scrollY),
    page_height: Math.round(document.documentElement.scrollHeight),
    viewport_height: window.innerHeight,
    truncated: text.length > limit,
    text: text.slice(0, limit),
  };
}

// NOTE: the injected functions below are serialized by chrome.scripting and run
// in the page's isolated world — they must be fully self-contained (no captured
// module scope), so each one inlines the __ghAgentElements index lookup.

const STALE_INDEX_ERROR = 'Stale or unknown element index — the page changed. Call browser_get_elements again.';

function highlightElementInPage(index: number) {
  const kept = (window as unknown as Record<string, unknown>).__ghAgentElements as Element[] | undefined;
  const el = kept?.[index] as HTMLElement | undefined;
  if (!el || !el.isConnected) return { ok: false as const };
  el.scrollIntoView({ block: 'center' });
  const prevOutline = el.style.outline;
  const prevOffset = el.style.outlineOffset;
  el.style.outline = '2px solid #f59e0b';
  el.style.outlineOffset = '2px';
  setTimeout(() => {
    el.style.outline = prevOutline;
    el.style.outlineOffset = prevOffset;
  }, 3000);
  const text = (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  // Danger facts for the panel's Auto-mode policy.
  const input = el as HTMLInputElement;
  const type = (input.type || '').toLowerCase();
  const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
  const inForm = !!(input.form || el.closest('form'));
  const isSubmitButton =
    (el.tagName === 'BUTTON' && (input.type === 'submit' || !el.getAttribute('type'))) ||
    (el.tagName === 'INPUT' && (type === 'submit' || type === 'image'));
  return {
    ok: true as const,
    text,
    isPassword: type === 'password',
    isPayment: autocomplete.startsWith('cc-'),
    inForm,
    isSubmitButton,
  };
}

function clickElementInPage(index: number) {
  const kept = (window as unknown as Record<string, unknown>).__ghAgentElements as Element[] | undefined;
  const el = kept?.[index] as HTMLElement | undefined;
  if (!el || !el.isConnected) {
    return { error: 'Stale or unknown element index — the page changed. Call browser_get_elements again.' };
  }
  el.scrollIntoView({ block: 'center' });
  const rect = el.getBoundingClientRect();
  const eventInit: MouseEventInit = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: rect.x + rect.width / 2,
    clientY: rect.y + rect.height / 2,
  };
  el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
  el.dispatchEvent(new MouseEvent('mousedown', eventInit));
  el.dispatchEvent(new PointerEvent('pointerup', eventInit));
  el.dispatchEvent(new MouseEvent('mouseup', eventInit));
  el.click();
  return { ok: true, clicked: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80) };
}

function typeInElementInPage(index: number, text: string, pressEnter: boolean) {
  const kept = (window as unknown as Record<string, unknown>).__ghAgentElements as Element[] | undefined;
  const el = kept?.[index] as HTMLElement | undefined;
  if (!el || !el.isConnected) {
    return { error: 'Stale or unknown element index — the page changed. Call browser_get_elements again.' };
  }
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Use the prototype's value setter so React/Vue-controlled inputs see the change.
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true }));
  } else {
    return { error: 'Element is not an editable field. Pick an input/textarea from browser_get_elements.' };
  }
  if (pressEnter) {
    const form = (el as HTMLInputElement).form;
    if (form) {
      // Synthetic Enter never triggers native form submission — submit explicitly.
      form.requestSubmit();
    } else {
      const keyInit: KeyboardEventInit = { bubbles: true, cancelable: true, key: 'Enter', code: 'Enter' };
      el.dispatchEvent(new KeyboardEvent('keydown', keyInit));
      el.dispatchEvent(new KeyboardEvent('keypress', keyInit));
      el.dispatchEvent(new KeyboardEvent('keyup', keyInit));
    }
  }
  return { ok: true, submitted: pressEnter };
}

function scrollInPage(direction: 'up' | 'down') {
  const delta = window.innerHeight * 0.8 * (direction === 'down' ? 1 : -1);
  window.scrollBy({ top: delta, behavior: 'instant' as ScrollBehavior });
  const pageHeight = Math.round(document.documentElement.scrollHeight);
  const scrollY = Math.round(window.scrollY);
  return {
    scroll_y: scrollY,
    page_height: pageHeight,
    at_bottom: scrollY + window.innerHeight >= pageHeight - 4,
    at_top: scrollY <= 0,
  };
}

// ─── Tab helpers ─────────────────────────────────────────

async function resolveTargetTab(tabId?: number): Promise<chrome.tabs.Tab | { error: string }> {
  const tab = tabId
    ? await chrome.tabs.get(tabId).catch(() => null)
    : ((await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? null);
  if (!tab?.id) return { error: tabId ? `Tab ${tabId} not found — call browser_list_tabs.` : 'No active tab.' };
  if (isRestrictedUrl(tab.url)) {
    return { error: 'This page cannot be accessed by the extension (browser-internal or store page).' };
  }
  return tab;
}

/** Wait until a tab finishes loading (or the timeout elapses — not an error). */
function waitForTabLoad(tabId: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, LOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') done();
    }, done);
  });
}

async function inject<A extends unknown[], R>(
  tabId: number,
  func: (...args: A) => R,
  args: A,
): Promise<{ result: R } | { error: string }> {
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
    return { result: frame?.result as R };
  } catch {
    return {
      error:
        'No permission to access this site. Ask the user to grant site access from the side panel (context card → allow this site / all sites), then retry.',
    };
  }
}

// ─── Executor ────────────────────────────────────────────

/**
 * Execute one agent-requested browser action. Never throws — failures and
 * declines come back as `{ error }` so the model can adapt.
 */
export async function executeBrowserAction(
  toolId: string,
  params: Record<string, unknown>,
  confirm: ConfirmFn,
): Promise<ActionResult> {
  try {
    return await run(toolId, params, confirm);
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function run(toolId: string, params: Record<string, unknown>, confirm: ConfirmFn): Promise<ActionResult> {
  switch (toolId) {
    case 'browser_list_tabs': {
      const tabs = await chrome.tabs.query({ windowType: 'normal' });
      return {
        output: {
          tabs: tabs.slice(0, MAX_TABS).map((t) => ({
            tab_id: t.id,
            url: (t.url ?? '').slice(0, 300),
            title: (t.title ?? '').slice(0, 120),
            active: t.active || undefined,
          })),
          truncated: tabs.length > MAX_TABS,
        },
      };
    }

    case 'browser_open_tab': {
      const url = String(params.url ?? '');
      if (!/^https?:\/\//.test(url)) return { error: 'Only absolute http(s) URLs can be opened.' };
      const tab = await chrome.tabs.create({ url, active: true });
      if (!tab.id) return { error: 'Failed to open tab.' };
      await waitForTabLoad(tab.id);
      const loaded = await chrome.tabs.get(tab.id).catch(() => null);
      return {
        output: {
          tab_id: tab.id,
          url: (loaded?.url ?? url).slice(0, 300),
          title: (loaded?.title ?? '').slice(0, 120),
        },
      };
    }

    case 'browser_wait': {
      const seconds = Math.min(Math.max(Number(params.seconds) || 1, 1), 10);
      await new Promise((r) => setTimeout(r, seconds * 1000));
      return { output: { ok: true, waited_seconds: seconds } };
    }
  }

  // Everything below runs inside a page.
  const tab = await resolveTargetTab(typeof params.tab_id === 'number' ? params.tab_id : undefined);
  if ('error' in tab) return tab;
  const tabId = tab.id!;

  switch (toolId) {
    case 'browser_read_page': {
      const res = await inject(tabId, readPageInPage, [READ_PAGE_LIMIT]);
      return 'error' in res ? res : { output: res.result };
    }

    case 'browser_get_elements': {
      const res = await inject(tabId, collectElementsInPage, [MAX_ELEMENTS]);
      return 'error' in res ? res : { output: res.result };
    }

    case 'browser_scroll': {
      const direction = params.direction === 'up' ? 'up' : 'down';
      const res = await inject(tabId, scrollInPage, [direction] as ['up' | 'down']);
      return 'error' in res ? res : { output: res.result };
    }

    case 'browser_click':
    case 'browser_type': {
      const index = Number(params.index);
      if (!Number.isInteger(index) || index < 0) return { error: 'A valid element index is required.' };

      // Highlight the target so the user sees exactly what will be acted on,
      // then gate on their approval. Highlight failure = stale index.
      const hl = await inject(tabId, highlightElementInPage, [index]);
      if ('error' in hl) return hl;
      if (!hl.result.ok) return { error: STALE_INDEX_ERROR };

      if (CONFIRM_ACTIONS.has(toolId)) {
        const pressEnter = params.press_enter === true;
        const willSubmit = hl.result.isSubmitButton || (toolId === 'browser_type' && pressEnter && hl.result.inForm);
        const allowed = await confirm({
          toolId,
          targetText: hl.result.text,
          inputText: toolId === 'browser_type' ? String(params.text ?? '') : undefined,
          pageUrl: tab.url,
          signals: {
            isPassword: hl.result.isPassword,
            isPayment: hl.result.isPayment,
            willSubmit,
            isSensitiveDomain: isSensitiveHost(hostFromUrl(tab.url)),
          },
        });
        if (!allowed) {
          return { error: 'User declined this action. Do not retry — ask the user how to proceed instead.' };
        }
      }

      const res =
        toolId === 'browser_click'
          ? await inject(tabId, clickElementInPage, [index])
          : await inject(tabId, typeInElementInPage, [index, String(params.text ?? ''), params.press_enter === true]);
      if ('error' in res) return res;
      const out = res.result as Record<string, unknown> | { error: string };
      if (out && typeof out === 'object' && 'error' in out) return { error: String(out.error) };
      return { output: out };
    }

    default:
      return { error: `Unknown browser action: ${toolId}` };
  }
}
