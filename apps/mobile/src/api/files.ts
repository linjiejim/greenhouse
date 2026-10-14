/**
 * The file service on API v2 (`/api/files`): uploads (multipart: `file`, `purpose`, optional
 * `conversation_id`; up to 50 MB, avatars 5 MB) and a file's view with a fresh signed URL.
 *
 * File bytes are only ever read through `FileView.url` — a short-lived URL signed for this
 * member (`/api/files/:id/content?exp=&m=&sig=`), so an image or a download needs no bearer
 * header. It is relative: `fileUrl` resolves it against the active station.
 *
 * Pictures are downscaled before they go (≤ 1600 px on the long edge, JPEG): the model sees
 * them anyway, and a phone photo is several megabytes.
 */

import { Platform } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { File as LocalFile } from 'expo-file-system';
import type { FileView } from '../shared/contract';
import { getApiBase } from '../store/stations';
import { get, request, seg } from './client';

const MAX_EDGE = 1600;

/** Downscale a picked image to ≤ MAX_EDGE wide (no upscaling). Falls back to the original on failure. */
export async function prepareImage(uri: string, width?: number): Promise<string> {
  if (width !== undefined && width <= MAX_EDGE) return uri;
  try {
    const ctx = ImageManipulator.manipulate(uri);
    ctx.resize({ width: MAX_EDGE });
    const image = await ctx.renderAsync();
    const result = await image.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
    return result.uri;
  } catch {
    return uri;
  }
}

export type UploadPurpose = 'attachment' | 'avatar';

/** Uploads a local file (a picked photo or document) and answers its view. */
export async function uploadFile(
  uri: string,
  fields: { name: string; type: string; purpose?: UploadPurpose; conversationId?: string },
) {
  const form = new FormData();
  if (Platform.OS === 'web') {
    try {
      const blob = await (await fetch(uri)).blob();
      form.append('file', new File([blob], fields.name, { type: blob.type || fields.type }));
    } catch {
      return { ok: false as const, status: 0, code: 'network', message: '' };
    }
  } else {
    // Expo fetch serializes expo-file-system Files with their bytes; plain RN URI descriptors fail.
    form.append('file', new LocalFile(uri));
  }
  form.append('purpose', fields.purpose ?? 'attachment');
  if (fields.conversationId) form.append('conversation_id', fields.conversationId);
  return request<FileView>('POST', '/api/files', { body: form });
}

/** What a file is, with a fresh signed URL for me. */
export const getFile = (id: string) => get<FileView>(`/api/files/${seg(id)}`);

/**
 * Absolute URL for a (possibly relative) file or picture URL, resolved against the active
 * station with `new URL` — the way a browser resolves an `src` — never by joining strings: a path
 * lands on the station (`@host…` stays a path instead of turning the station into userinfo), an
 * absolute URL is kept. Loaded without the token: the signature is the credential.
 */
export function fileUrl(url: string): string {
  try {
    return new URL(url, getApiBase()).href;
  } catch {
    return url;
  }
}
