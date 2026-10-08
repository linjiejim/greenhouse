/**
 * Image upload — POST /api/upload (multipart, images only, 5 MB cap on the
 * server). Mirrors the web client: downscale to ≤1024px client-side first
 * (apps/web/src/lib/api/upload.ts does the same via canvas).
 */

import { Platform } from 'react-native';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import type { UploadResult } from '../shared/greenhouse-types';
import { getApiBase } from '../store/stations';
import { api } from './client';

const MAX_EDGE = 1024;

/** Downscale a picked image to ≤1024px wide (no upscaling). Falls back to the original on failure. */
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

export async function uploadImage(uri: string, mime = 'image/jpeg'): Promise<UploadResult | null> {
  try {
    const form = new FormData();
    if (Platform.OS === 'web') {
      const blob = await (await fetch(uri)).blob();
      form.append('file', new File([blob], 'photo.jpg', { type: blob.type || mime }));
    } else {
      // React Native FormData file descriptor.
      form.append('file', { uri, name: 'photo.jpg', type: mime } as unknown as Blob);
    }
    const res = await api('/api/upload', { method: 'POST', body: form });
    if (!res.ok) return null;
    return (await res.json()) as UploadResult;
  } catch {
    return null;
  }
}

/**
 * Absolute URL for a (possibly relative) upload url, resolved against the active station with
 * `new URL` — the way a browser resolves an `src` — never by joining strings: a path lands on the
 * station (`@host…` stays a path instead of turning the station into userinfo), an absolute URL is
 * kept. Loaded without the token (thumbnails, the Safari view), so another origin costs nothing.
 * An unparsable value comes back as given (it then fails to load).
 */
export function uploadUrl(url: string): string {
  try {
    return new URL(url, getApiBase()).href;
  } catch {
    return url;
  }
}
