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
}

export function requestComposerDraft(draft: ComposerDraft): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(COMPOSER_DRAFT_EVENT, { detail: draft }));
}

export function onComposerDraft(listener: (draft: ComposerDraft) => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (event: Event) => listener((event as CustomEvent<ComposerDraft>).detail);
  window.addEventListener(COMPOSER_DRAFT_EVENT, handler);
  return () => window.removeEventListener(COMPOSER_DRAFT_EVENT, handler);
}
