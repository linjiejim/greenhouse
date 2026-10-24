/** What the composer is about to send besides its text. React-free (./composer-files.test.ts). */

import type { SentImage } from '../data/conversation';
import type { AttachedFile } from './parts';

/** A file picked for the next message: uploading, ready (what the station answered) or failed. */
export interface ComposerFile {
  id: string;
  uri: string;
  name: string;
  kind: 'image' | 'file';
  width?: number;
  height?: number;
  mimeType?: string;
  size?: number;
  status: 'uploading' | 'done' | 'error';
  remote?: { kind: 'image'; image: SentImage } | { kind: 'file'; file: AttachedFile };
}

/** The most files one message carries (the web's limit). */
export const MAX_FILES = 10;

/** Sending waits for every file the member picked: never send only part of it. */
export function filesReady(files: readonly ComposerFile[]): boolean {
  return files.every((file) => file.status === 'done' && !!file.remote);
}

/** Something to send: words or a file — and nothing still uploading or failed. */
export function canSendMessage(text: string, files: readonly ComposerFile[]): boolean {
  return filesReady(files) && (text.trim().length > 0 || files.length > 0);
}

/** The pictures and attached files of a ready draft, as the message carries them. */
export function sentParts(files: readonly ComposerFile[]): { images: SentImage[]; attachments: AttachedFile[] } {
  const images: SentImage[] = [];
  const attachments: AttachedFile[] = [];
  for (const file of files) {
    if (file.remote?.kind === 'image') images.push(file.remote.image);
    else if (file.remote?.kind === 'file') attachments.push(file.remote.file);
  }
  return { images, attachments };
}

/** A picture the upload endpoint takes (`/api/upload`: JPEG, PNG, WebP, GIF). */
export function uploadsAsImage(mimeType: string | undefined, name: string): boolean {
  return /^image\/(jpeg|png|webp|gif|heic|heif)$/i.test(mimeType ?? '') || /\.(jpe?g|png|webp|gif|heic|heif)$/i.test(name);
}
