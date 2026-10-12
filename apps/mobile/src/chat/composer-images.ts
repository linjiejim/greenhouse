/** Image draft state shared by both chat screens and their composer. No React. */
export interface ComposerImage {
  id: string;
  uri: string;
  width?: number;
  mimeType?: string;
  status: 'uploading' | 'done' | 'error';
  remote?: { id: string; url: string };
}

/** Never send only part of what the member selected. */
export function canSendMessage(text: string, images: readonly ComposerImage[]): boolean {
  return (
    images.every((image) => image.status === 'done' && !!image.remote) && (text.trim().length > 0 || images.length > 0)
  );
}

/** A screen's pending upload cannot survive unmount; keep its image for retry. */
export function recoverDraftImages(images: readonly ComposerImage[]): ComposerImage[] {
  return images.map((image) => (image.status === 'uploading' ? { ...image, status: 'error' } : image));
}
