/** What the composer is about to send besides its text: files and what it quotes. No React. */

import type { FileView } from '../shared/contract';

/** A file picked for the next message: uploading, ready (its `remote` view) or failed. */
export interface ComposerFile {
  id: string;
  uri: string;
  name: string;
  kind: 'image' | 'file';
  /** Picked images' width, to scale them down before they go. */
  width?: number;
  mimeType?: string;
  size?: number;
  status: 'uploading' | 'done' | 'error';
  remote?: FileView;
}

/** The most files one message carries (the API's limit). */
export const MAX_FILES = 10;

/** Sending waits for every file the member picked: never send only part of it. */
export function filesReady(files: readonly ComposerFile[]): boolean {
  return files.every((file) => file.status === 'done' && !!file.remote);
}

/** Something to send: text, a file or a chosen skill — and nothing still uploading or failed. */
export function canSendMessage(text: string, files: readonly ComposerFile[], skill = false): boolean {
  return filesReady(files) && (text.trim().length > 0 || files.length > 0 || skill);
}

/** A screen's pending upload cannot survive unmount; keep its file for a retry. */
export function recoverDraftFiles(files: readonly ComposerFile[]): ComposerFile[] {
  return files.map((file) => (file.status === 'uploading' ? { ...file, status: 'error' } : file));
}
