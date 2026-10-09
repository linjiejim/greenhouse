/**
 * Hand a prepared turn to the conversation composer.
 *
 * The annotator lives in the side pane and the composer lives in
 * ConversationPane; neither owns the other, and threading a callback down
 * would mean adding a prop to every host that renders a pane.
 *
 * Crucially the draft is EDITABLE, not sent: the annotator supplies a starting
 * point ("change the original per the red marks"), and the user adds whatever
 * the drawing could not say before pressing send. Auto-sending would make a
 * mis-drawn circle cost a full image generation.
 */

export const COMPOSER_DRAFT_EVENT = 'greenhouse:composer-draft';

export interface ComposerDraft {
  /** Prefilled text; the user can edit it before sending. */
  text: string;
  /** Already-uploaded images to attach, in order. */
  images: Array<{ id: string; url: string }>;
  /** Add after what the user already typed instead of replacing it. */
  append?: boolean;
  /**
   * Offered by a page in the html-preview pane (`window.greenhouse.sendPrompt`).
   * A viewer who cannot write to the conversation ignores it.
   */
  fromPage?: boolean;
}

/** Whether a composer took the draft — so the sender only reports what really happened. */
export function requestComposerDraft(draft: ComposerDraft): boolean {
  if (typeof window === 'undefined') return false;
  const event = new CustomEvent(COMPOSER_DRAFT_EVENT, { detail: draft, cancelable: true });
  return !window.dispatchEvent(event);
}

/** `listener` returns false to decline the draft (a page's text for a viewer who cannot write). */
export function onComposerDraft(listener: (draft: ComposerDraft) => boolean | void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => {
    // A cancelled event is the "taken" signal requestComposerDraft reads.
    if (listener((event as CustomEvent<ComposerDraft>).detail) !== false) event.preventDefault();
  };
  window.addEventListener(COMPOSER_DRAFT_EVENT, handler);
  return () => window.removeEventListener(COMPOSER_DRAFT_EVENT, handler);
}
