/**
 * Browser automation action descriptors — the extension's "hands".
 *
 * Advertised to POST /api/chat as `client_actions` each turn; the backend turns
 * each into an agent tool whose execute() round-trips back to this client via
 * the `local-tool-request` stream event (see lib/browser-tools.ts for the
 * executors). Pure data, no chrome.* references — unit-testable.
 *
 * Server-side constraints (apps/api/src/tools/client-actions.ts): name must
 * match /^[a-z][a-z0-9_]*$/ and be ≤64 chars, description ≤2000 chars,
 * parameters must be a JSON-schema object. Max 32 actions.
 *
 * Safety tiers (enforced client-side in browser-tools.ts):
 * - read/navigate actions run automatically;
 * - CONFIRM_ACTIONS (click / type) always require per-action user approval
 *   in the side panel — same policy as knowledge write-back.
 */

import type { ClientActionDescriptor } from '@greenhouse/types/api';

/** Actions that must be confirmed by the user before executing. */
export const CONFIRM_ACTIONS = new Set(['browser_click', 'browser_type']);

const TAB_ID_PARAM = {
  tab_id: {
    type: 'number',
    description: 'Target tab id (from browser_list_tabs / browser_open_tab). Defaults to the active tab.',
  },
} as const;

export const BROWSER_ACTION_DESCRIPTORS: ClientActionDescriptor[] = [
  {
    name: 'browser_list_tabs',
    description:
      'List the currently open browser tabs (id, url, title, which one is active). Use to find an existing tab before opening a new one.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'browser_open_tab',
    description:
      'Open an http/https URL in a new browser tab and wait for it to finish loading. Use for navigation — e.g. opening a search engine results page (https://www.bing.com/search?q=...) or a link you discovered. Returns the new tab id, final url and title.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to open.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'browser_read_page',
    description:
      'Read the text content of a page (url, title, extracted body text, scroll position). Content is truncated — use browser_scroll and read again, or browser_get_elements to find links, if you need more.',
    parameters: { type: 'object', properties: { ...TAB_ID_PARAM } },
  },
  {
    name: 'browser_get_elements',
    description:
      'List the interactive elements of a page (links, buttons, inputs, selects...) as an indexed list with text/labels. You MUST call this before browser_click or browser_type, and call it again after any navigation or page change — element indices go stale.',
    parameters: { type: 'object', properties: { ...TAB_ID_PARAM } },
  },
  {
    name: 'browser_click',
    description:
      'Click an interactive element by its index from browser_get_elements. The user must approve each click in the side panel; a decline is not an error you should retry — ask the user instead. After a click that navigates, re-read the page.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Element index from the latest browser_get_elements call.' },
        ...TAB_ID_PARAM,
      },
      required: ['index'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input/textarea/editable element by its index from browser_get_elements, optionally pressing Enter (submits search boxes and forms). The user must approve each use in the side panel. The typed text replaces the field content.',
    parameters: {
      type: 'object',
      properties: {
        index: { type: 'number', description: 'Element index from the latest browser_get_elements call.' },
        text: { type: 'string', description: 'Text to put into the field.' },
        press_enter: { type: 'boolean', description: 'Press Enter / submit the form after typing (default false).' },
        ...TAB_ID_PARAM,
      },
      required: ['index', 'text'],
    },
  },
  {
    name: 'browser_scroll',
    description:
      'Scroll the page up or down by roughly one viewport. Returns the new scroll position and whether the bottom was reached. Follow with browser_read_page or browser_get_elements to see the newly visible content.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction.' },
        ...TAB_ID_PARAM,
      },
      required: ['direction'],
    },
  },
  {
    name: 'browser_wait',
    description:
      'Wait for a page that is still loading or rendering (1–10 seconds). Use sparingly after clicks that trigger slow updates.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Seconds to wait (1–10).' },
      },
      required: ['seconds'],
    },
  },
];
