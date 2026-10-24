/**
 * What a member sends with a message, on the v1 API:
 *
 *  - pictures go to `POST /api/upload` (multipart `file`; JPEG, PNG, WebP or GIF up to 5 MB) and
 *    ride on the message as `images: [{ id, url }]` — the model sees them; their URL is public by
 *    id, like the web's;
 *  - any other file goes to `POST /api/chat-files/upload` (multipart `file` + `session_id`, up to
 *    100 MB) and rides in the message as an ```attachments fence (src/chat/parts.ts); it downloads
 *    only with the session (`/api/chat-files/<id>/content`).
 *
 * Pictures are scaled down first (≤ 1600 px on the long edge, JPEG): a phone photo is several
 * megabytes and over the limit. Multipart bodies go through Expo's fetch, which streams an
 * expo-file-system File from disk. Every call answers an `ApiResult`, never throws.
 */

import { fetch as expoFetch } from 'expo/fetch';
import { File as LocalFile } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import { api, networkMiss, toResult, type ApiResult } from './client';

const MAX_EDGE = 1600;

/** Downscale (and re-encode as JPEG) a picked picture; the original when it cannot. */
export async function prepareImage(uri: string, width?: number, height?: number): Promise<{ uri: string; scaled: boolean }> {
  const long = Math.max(width ?? 0, height ?? 0);
  if (long && long <= MAX_EDGE && /\.(jpe?g|png|webp|gif)$/i.test(uri)) return { uri, scaled: false };
  try {
    const ctx = ImageManipulator.manipulate(uri);
    if (!long || long > MAX_EDGE) {
      ctx.resize((width ?? 0) >= (height ?? 0) ? { width: MAX_EDGE } : { height: MAX_EDGE });
    }
    const image = await ctx.renderAsync();
    const result = await image.saveAsync({ compress: 0.85, format: SaveFormat.JPEG });
    return { uri: result.uri, scaled: true };
  } catch {
    return { uri, scaled: false };
  }
}

async function multipart<T>(path: string, form: FormData): Promise<ApiResult<T>> {
  try {
    const res = await api(path, { method: 'POST', body: form }, expoFetch as unknown as typeof fetch);
    return await toResult<T>(res);
  } catch (error) {
    return networkMiss(error);
  }
}

export interface UploadedImage {
  id: string;
  url: string;
}

export function uploadImage(uri: string): Promise<ApiResult<UploadedImage>> {
  const form = new FormData();
  form.append('file', new LocalFile(uri) as unknown as Blob);
  return multipart<UploadedImage>('/api/upload', form);
}

export interface ChatFile {
  id: string;
  name: string;
  content_type?: string;
  size?: number;
}

export async function uploadChatFile(sessionId: string, uri: string): Promise<ApiResult<ChatFile>> {
  const form = new FormData();
  form.append('file', new LocalFile(uri) as unknown as Blob);
  form.append('session_id', sessionId);
  const result = await multipart<{ file: ChatFile }>('/api/chat-files/upload', form);
  return result.ok ? { ok: true, data: result.data.file } : result;
}
