/**
 * Close the sheet on top, then open what comes next — one animation at a time (./close-then.test.ts).
 *
 * An iOS release build aborted once (SIGABRT: a JS error inside a Reanimated worklet during an
 * animation frame) right after Create on a new document, when three animations overlapped: the
 * form sheet dismissing, the keyboard going down and the document sheet presenting (pushed from a
 * 0 ms timer). Here the keyboard goes down first and is waited for, then the sheet closes, then
 * the next screen opens once the dismissal has run (AFTER_DISMISS_MS, the wait the auth reroute
 * uses too). The closing sheet's own `transitionEnd` cannot be awaited: `router.back()` unmounts
 * it while UIKit still animates it out, and InteractionManager is a deprecated no-op stub in
 * React Native 0.86. Browser: ./close-then.web.ts.
 */

import { KeyboardController } from 'react-native-keyboard-controller';
import { AFTER_DISMISS_MS } from '../store/auth';

/** Longest wait for the keyboard; a dismissal that never reports back must not hold the flow. */
export const KEYBOARD_WAIT_MS = 600;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The keyboard down (resolves at once when it is not up). */
export async function keyboardDown(): Promise<void> {
  if (!KeyboardController.isVisible()) return;
  await Promise.race([KeyboardController.dismiss().catch(() => undefined), delay(KEYBOARD_WAIT_MS)]);
}

/** Put the keyboard down, `close` the sheet, wait for its dismissal, then `open`. */
export async function closeThen(close: () => void, open: () => void): Promise<void> {
  await keyboardDown();
  close();
  await delay(AFTER_DISMISS_MS);
  open();
}
