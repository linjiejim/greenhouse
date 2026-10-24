/**
 * Hold-to-talk, as pure rules. React-free (./dictation.test.ts).
 *
 * The mic is held while speaking; the words appear live. Lifting the finger sends what was
 * heard (with anything already typed in front of it); sliding up past CANCEL_DISTANCE and
 * lifting there throws the recording away. A recording that heard nothing sends nothing.
 */

/** How far up (points) the finger slides before lifting cancels. */
export const CANCEL_DISTANCE = 64;

export function cancelArmed(dy: number): boolean {
  return dy <= -CANCEL_DISTANCE;
}

/** What gets sent when the finger lifts: the draft and the words heard, or nothing. */
export function dictatedMessage(draft: string, heard: string): string | null {
  const words = heard.trim();
  if (!words) return null;
  const typed = draft.trimEnd();
  return typed ? `${typed} ${words}` : words;
}

/** The recognizer's language for the app's language. */
export function dictationLocale(lang: 'zh' | 'en'): string {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}
