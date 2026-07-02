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

const SELECTION_LIMIT = 4_000;
const PAGE_TEXT_LIMIT = 8_000;

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

/** Render the per-turn context_hint block sent alongside the user message. */
export function buildContextHint(ctx: PageContext, fullPageText?: string | null): string | undefined {
  if (!ctx.url && !ctx.selection && !fullPageText) return undefined;
  const lines: string[] = ['The user is currently browsing this web page:'];
  if (ctx.url) lines.push(`URL: ${ctx.url}`);
  if (ctx.title) lines.push(`Title: ${ctx.title}`);
  if (ctx.selection) {
    lines.push('Text the user selected on the page:', '"""', ctx.selection, '"""');
  } else if (fullPageText) {
    lines.push('Page content (extracted):', '"""', fullPageText, '"""');
  }
  return lines.join('\n');
}
