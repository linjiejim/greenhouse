/**
 * Screenshot → chat attachment.
 *
 * The shell hands back base64 already sized to survive `/api/upload`; this turns it
 * into a `File` so it flows through exactly the same path as a pasted or dropped
 * image (`handleImageSelect` in the agent panel / chat page). One attachment path,
 * not two.
 */

import { uploadImage } from '../api/upload';
import { invokeDesktop } from './bridge';
import type { CaptureMode } from './types';

/**
 * Screenshots are read for their *text*, so they keep far more resolution than the
 * 1024px default meant for plant photos. The shell already caps the longest edge at
 * 2400px, so this only prevents the upload path from shrinking it again.
 */
const SCREENSHOT_MAX_DIMENSION = 2400;

/** `null` means the user cancelled the capture, which is not an error. */
export async function captureToFile(mode: CaptureMode): Promise<File | null> {
  const capture = await invokeDesktop('desktop_capture_screen', { mode });
  if (!capture) return null;

  const extension = capture.mime === 'image/jpeg' ? 'jpg' : 'png';
  return new File([base64ToBytes(capture.base64)], `screenshot-${stamp()}.${extension}`, {
    type: capture.mime,
  });
}

/**
 * Capture and upload in one step, returning the upload id.
 *
 * This is the shape the agent needs: it can pass the id straight to `analyze_image`.
 * Handing the model raw base64 would blow up the context for no benefit.
 */
export async function captureAndUpload(
  mode: CaptureMode,
): Promise<{ imageId: string; url: string; name: string } | null> {
  const file = await captureToFile(mode);
  if (!file) return null;
  const uploaded = await uploadImage(file, { maxDimension: SCREENSHOT_MAX_DIMENSION });
  return { imageId: uploaded.id, url: uploaded.url, name: file.name };
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  // Allocate the ArrayBuffer explicitly: a bare Uint8Array is typed over
  // ArrayBufferLike, which TS won't accept as a BlobPart.
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return buffer;
}

/** `20260730-014233`, so saved screenshots sort chronologically. */
function stamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}
