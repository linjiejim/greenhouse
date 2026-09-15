/**
 * Native capabilities, exposed to the agent as client actions.
 *
 * This is the whole backend integration: `apps/api/src/tools/client-actions.ts`
 * already turns whatever the browser declares each turn into agent tools, so the
 * desktop gets agent-callable native capabilities with **zero** server-side change.
 * The same registry also drives the confirm gate in
 * `apps/web/src/lib/client-actions/executor.ts`.
 *
 * Safety rule applied below: anything that reads or writes the user's data —
 * screen, selection, clipboard — is `confirm`. The agent may ask; the user decides.
 *
 * Not registered here: the file picker. An agent that can pop a file dialog is more
 * annoying than useful, and the user attaching a file themselves is one click.
 */

import { GLOBAL_CLIENT_ACTION_SCOPE, registerClientAction } from '../client-actions/registry';
import { invokeDesktop, isDesktop } from './bridge';
import { getCapabilities } from './capabilities';
import { captureAndUpload } from './capture';
import type { CaptureMode } from './types';

/** Clipboard contents can be enormous; the agent needs a sample, not a novel. */
const MAX_TEXT_CHARS = 20_000;

function truncate(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS), truncated: true };
}

/**
 * Register the desktop's native capabilities with the client-action registry.
 * Returns an unregister function; a no-op (and no registrations) in a browser.
 */
export function registerDesktopActions(): () => void {
  if (!isDesktop()) return () => {};

  const unregisters = [
    registerClientAction(GLOBAL_CLIENT_ACTION_SCOPE, {
      name: 'desktop_capture_screen',
      description:
        "Take a screenshot of the user's screen and upload it. Returns an image_id — pass that to analyze_image to actually read the picture. " +
        "mode 'interactive' (default, macOS) lets the user drag out a region; 'window' lets them click a window; 'full' grabs the whole screen with no interaction. " +
        'Use this when the user refers to something on their screen instead of asking them to describe or paste it. Returns cancelled:true if they dismiss the capture.',
      parameters: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['interactive', 'window', 'full'],
            description: 'How to choose what to capture. Defaults to interactive.',
          },
        },
      },
      safety: 'confirm',
      execute: async (params) => {
        const requested = (params.mode as CaptureMode) ?? 'interactive';
        // Only macOS can drag out a region; asking for it elsewhere would silently
        // return a full-screen grab, so downgrade explicitly and say so.
        const caps = await getCapabilities({ refresh: true });
        const mode: CaptureMode = caps.interactiveCapture ? requested : 'full';

        const result = await captureAndUpload(mode);
        if (!result) return { cancelled: true };
        return {
          image_id: result.imageId,
          mode,
          downgraded_from: mode === requested ? undefined : requested,
          next_step: 'Call analyze_image with this image_id to read the screenshot.',
        };
      },
    }),

    registerClientAction(GLOBAL_CLIENT_ACTION_SCOPE, {
      name: 'desktop_read_selection',
      description:
        'Read the text the user currently has selected in ANY application (their editor, browser, a PDF, …), not just this one. ' +
        'Use it when the user says "this", "the selected text", or "what I have highlighted". Returns null if nothing is selected or the app does not expose its selection.',
      parameters: { type: 'object', properties: {} },
      safety: 'confirm',
      execute: async () => {
        const selection = await invokeDesktop('desktop_read_selection');
        if (!selection)
          return { selection: null, reason: 'Nothing selected, or the app does not expose its selection' };
        const { text, truncated } = truncate(selection.text);
        return { selection: text, truncated, source: selection.source };
      },
    }),

    registerClientAction(GLOBAL_CLIENT_ACTION_SCOPE, {
      name: 'desktop_read_clipboard',
      description:
        'Read the text on the user\'s system clipboard. Use when they say "what I just copied" or paste-by-reference. Returns null when the clipboard is empty or holds something that is not text.',
      parameters: { type: 'object', properties: {} },
      safety: 'confirm',
      execute: async () => {
        const clipboard = await invokeDesktop('desktop_read_clipboard');
        if (!clipboard) return { clipboard: null };
        const { text, truncated } = truncate(clipboard);
        return { clipboard: text, truncated };
      },
    }),

    registerClientAction(GLOBAL_CLIENT_ACTION_SCOPE, {
      name: 'desktop_write_clipboard',
      description:
        "Put text on the user's system clipboard so they can paste it elsewhere. Use when they ask you to copy something for them. This REPLACES whatever they had copied.",
      parameters: {
        type: 'object',
        properties: { text: { type: 'string', description: 'The text to place on the clipboard.' } },
        required: ['text'],
      },
      safety: 'confirm',
      execute: async (params) => {
        const text = typeof params.text === 'string' ? params.text : '';
        if (!text) return { ok: false, error: 'No text provided' };
        await invokeDesktop('desktop_write_clipboard', { text });
        return { ok: true, chars: text.length };
      },
    }),
  ];

  return () => unregisters.forEach((unregister) => unregister());
}
