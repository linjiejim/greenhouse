/**
 * Passing captured context from a satellite window to the main one.
 *
 * Each Tauri window is a separate JS context, so the in-process channel in
 * `attach.ts` can't cross between them. Tauri's own event bus can: `emit` broadcasts
 * to every window, and the main window is the only one that listens.
 *
 * No Rust involved — which means the whole hand-off protocol is hot-updatable.
 */

import { publishAttachment } from './attach';
import { invokeDesktop, isDesktop, onDesktopEvent } from './bridge';

const HANDOFF_EVENT = 'greenhouse://handoff';

export interface Handoff {
  /** Launcher-style intents belong in full Chat; satellite captures default to Assistant. */
  target?: 'chat' | 'assistant';
  draft?: string;
  /** Send straight away instead of leaving it in the composer for editing. */
  autoSend?: boolean;
  /** Start the conversation with the profile selected in a satellite surface. */
  profileId?: string;
  /** Force a fresh conversation instead of reusing the open one. */
  newConversation?: boolean;
  /** Open an existing conversation without transferring any message content. */
  sessionId?: string;
}

/** Send a typed launch intent to the main window and bring it forward. */
export async function handOffToMain(handoff: Handoff): Promise<void> {
  if (!isDesktop()) return;
  const { emit } = await import('@tauri-apps/api/event');
  await emit(HANDOFF_EVENT, handoff);
  await invokeDesktop('desktop_focus_main_window');
}

/** Main-window side: receive hand-offs through the existing Assistant launch seam. */
export async function listenForHandoff(): Promise<() => void> {
  return onDesktopEvent<Handoff>(HANDOFF_EVENT, (handoff) => {
    publishAttachment(handoff);
  });
}
