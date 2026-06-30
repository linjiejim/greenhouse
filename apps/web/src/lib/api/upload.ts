/**
 * Upload API — image upload with client-side compression.
 *
 * Stays on raw authFetch (not hc): the request body is FormData, and the
 * hc client conventions (see ./client.ts) reserve hc for JSON request/response.
 */

import { authFetch } from '../auth';
import type { UploadResult } from '@greenhouse/types/api';

const BASE = '';

export async function uploadImage(file: File): Promise<UploadResult> {
  // Compress image client-side before uploading
  const compressed = await compressImage(file, 1024);
  const formData = new FormData();
  formData.append('file', compressed);
  const res = await authFetch(`${BASE}/api/upload`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Upload failed' }));
    throw new Error(err.error || `Upload failed: ${res.status}`);
  }
  return res.json();
}

/**
 * Compress an image file client-side to fit within maxDimension pixels.
 * Returns the original file if it's already small enough or not an image.
 * NOTE: This is Web-only (uses Canvas API). RN would use expo-image-manipulator.
 */
async function compressImage(file: File, maxDimension: number): Promise<File> {
  if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const { width, height } = img;
      // No compression needed if already within bounds
      if (width <= maxDimension && height <= maxDimension) {
        URL.revokeObjectURL(img.src);
        resolve(file);
        return;
      }

      const scale = Math.min(maxDimension / width, maxDimension / height);
      const newW = Math.round(width * scale);
      const newH = Math.round(height * scale);

      const canvas = document.createElement('canvas');
      canvas.width = newW;
      canvas.height = newH;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0, newW, newH);
      URL.revokeObjectURL(img.src);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          const compressed = new File([blob], file.name, {
            type: 'image/jpeg',
            lastModified: file.lastModified,
          });
          console.log(
            `[Compress] ${file.name}: ${(file.size / 1024).toFixed(0)}KB → ${(compressed.size / 1024).toFixed(0)}KB (${width}×${height} → ${newW}×${newH})`,
          );
          resolve(compressed);
        },
        'image/jpeg',
        0.85,
      );
    };
    img.onerror = () => resolve(file);
    img.src = URL.createObjectURL(file);
  });
}
