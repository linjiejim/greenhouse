/**
 * Page context — selection-as-context, read on demand.
 *
 * No resident content script: when the panel needs the page's selection (or,
 * for the explicit "summarize page" action, its text) it injects a one-shot
 * function via chrome.scripting.executeScript. That requires host permission
 * for the site (granted per-site or for all sites from the selection card) or
 * an active activeTab grant; without it we degrade to whatever tab metadata is
 * available and surface a "grant access" affordance.
 */

import { AMBIENT_CONTEXT_LIMITS, type AmbientContextEnvelope } from '@greenhouse/types/agent-context';

// Nothing past the API's hint cap reaches the model, so don't read more than it.
const SELECTION_LIMIT = AMBIENT_CONTEXT_LIMITS.hint;
const PAGE_TEXT_LIMIT = AMBIENT_CONTEXT_LIMITS.hint;

export interface PageContext {
  tabId: number | null;
  url?: string;
  title?: string;
  selection?: string;
  /** False when the site needs a host-permission grant to read the selection. */
  permitted: boolean;
}

/** Pages the extension can never touch (browser UI, web stores, extension pages). */
function isRestrictedUrl(url: string | undefined): boolean {
  if (!url) return false;
  return /^(chrome|chrome-extension|edge|about|devtools):/.test(url) || url.startsWith('https://chromewebstore.');
}

export async function readPageContext(): Promise<PageContext> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id || isRestrictedUrl(tab.url)) {
    return { tabId: null, permitted: false };
  }
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({
        url: location.href,
        title: document.title,
        selection: window.getSelection()?.toString() ?? '',
      }),
    });
    const result = injected?.result as { url: string; title: string; selection: string } | undefined;
    if (!result) return { tabId: tab.id, url: tab.url, title: tab.title, permitted: false };
    return {
      tabId: tab.id,
      url: result.url,
      title: result.title,
      selection: result.selection.trim().slice(0, SELECTION_LIMIT) || undefined,
      permitted: true,
    };
  } catch {
    // No host permission for this site (and no live activeTab grant).
    return { tabId: tab.id, url: tab.url, title: tab.title, permitted: false };
  }
}

/** Ask for host access to the current site (or every site). Must run in a user gesture. */
export async function requestSiteAccess(url?: string): Promise<boolean> {
  let origins = ['http://*/*', 'https://*/*'];
  if (url) {
    try {
      origins = [`${new URL(url).origin}/*`];
    } catch {
      // Fall through to the all-sites request.
    }
  }
  return chrome.permissions.request({ origins });
}

/** Explicit full-page text extraction — only for user-triggered quick actions. */
export async function readFullPageText(tabId: number): Promise<string | null> {
  try {
    const [injected] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.body?.innerText ?? '',
    });
    const text = (injected?.result as string | undefined)?.replace(/\n{3,}/g, '\n\n').trim();
    return text ? text.slice(0, PAGE_TEXT_LIMIT) : null;
  } catch {
    return null;
  }
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host || undefined;
  } catch {
    return undefined;
  }
}

/** A quoted block that fits the hint cap: the quoted text is cut, never the frame around it. */
function quotedHint(lead: string, body: string): string {
  const frame = `${lead}\n"""\n`;
  const close = '\n"""';
  return frame + clip(body, AMBIENT_CONTEXT_LIMITS.hint - frame.length - close.length) + close;
}

/**
 * The per-turn `ambient_context` for the page the user is on: title as the
 * label, URL as the route, and their selection (or, for "summarize page", the
 * extracted text) as the hint. Sized to the API's caps so nothing is cut
 * server-side. Sent with the turn only; never stored in the conversation.
 */
export function buildPageAmbientContext(
  ctx: PageContext,
  scopeId: string,
  fullPageText?: string | null,
): AmbientContextEnvelope | undefined {
  if (!ctx.url) return undefined;
  const hint = ctx.selection
    ? quotedHint('Text the user selected on this page:', ctx.selection)
    : fullPageText
      ? quotedHint('Text extracted from this page:', fullPageText)
      : 'The user has this page open in their browser; nothing on it is selected.';
  return {
    version: 1,
    scope_id: scopeId,
    source: 'current-page',
    label: clip(ctx.title?.trim() || hostOf(ctx.url) || ctx.url, AMBIENT_CONTEXT_LIMITS.label),
    route: clip(ctx.url, AMBIENT_CONTEXT_LIMITS.route),
    hint,
  };
}
