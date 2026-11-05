/**
 * Everything the server needs besides the original, made in the browser: dimensions, a
 * video's duration, a 480 px thumbnail and a 1600 px preview (JPEG, which every browser can
 * encode), up to three keyframes, and a 64-bit difference hash for near-duplicate hints.
 * A file the browser cannot decode (HEIC outside Safari, an unusual codec) still uploads,
 * just without these.
 */
export interface Derived {
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  thumb: Blob | null;
  preview: Blob | null;
  frames: Blob[];
  phash: string | null;
}

const NONE: Derived = { width: null, height: null, duration_ms: null, thumb: null, preview: null, frames: [], phash: null };
const THUMB_EDGE = 480;
const PREVIEW_EDGE = 1600;
const FRAME_EDGE = 1024;

type Source = CanvasImageSource & { width?: number; height?: number };

function sized(width: number, height: number, edge: number) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * scale)), h: Math.max(1, Math.round(height * scale)) };
}

function encode(source: Source, width: number, height: number, edge: number, quality: number): Promise<Blob | null> {
  const { w, h } = sized(width, height, edge);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  // JPEG has no alpha: transparent pixels become white, not black.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(source, 0, 0, w, h);
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), 'image/jpeg', quality));
}

/** dHash: 9×8 grey pixels, one bit per horizontal neighbour comparison. */
function dhash(source: Source): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = 9;
  canvas.height = 8;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(source, 0, 0, 9, 8);
  const { data } = ctx.getImageData(0, 0, 9, 8);
  const grey = (x: number, y: number) => {
    const i = (y * 9 + x) * 4;
    return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
  };
  let bits = 0n;
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits = (bits << 1n) | (grey(x, y) > grey(x + 1, y) ? 1n : 0n);
  return bits.toString(16).padStart(16, '0');
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('cannot decode image'));
    img.src = url;
  });
}

async function deriveImage(file: File): Promise<Derived> {
  let source: Source;
  let width: number;
  let height: number;
  let url: string | null = null;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    source = bitmap;
    width = bitmap.width;
    height = bitmap.height;
  } catch {
    // Safari decodes HEIC through <img> but not createImageBitmap.
    url = URL.createObjectURL(file);
    const img = await loadImage(url);
    source = img;
    width = img.naturalWidth;
    height = img.naturalHeight;
  }
  try {
    const [thumb, preview] = await Promise.all([
      encode(source, width, height, THUMB_EDGE, 0.8),
      encode(source, width, height, PREVIEW_EDGE, 0.85),
    ]);
    return { width, height, duration_ms: null, thumb, preview, frames: [], phash: dhash(source) };
  } finally {
    if (url) URL.revokeObjectURL(url);
    if ('close' in source && typeof source.close === 'function') source.close();
  }
}

function once(target: EventTarget, event: string, ms: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} timed out`)), ms);
    target.addEventListener(
      event,
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    target.addEventListener(
      'error',
      () => {
        clearTimeout(timer);
        reject(new Error('cannot decode video'));
      },
      { once: true },
    );
  });
}

async function deriveVideo(file: File): Promise<Derived> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    await once(video, 'loadeddata', 20_000);
    const { videoWidth: width, videoHeight: height } = video;
    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    if (!width || !height) return { ...NONE, duration_ms: duration ? Math.round(duration * 1000) : null };
    const at = async (seconds: number) => {
      video.currentTime = Math.max(0, Math.min(seconds, Math.max(0, duration - 0.05)));
      await once(video, 'seeked', 15_000);
    };
    // Poster: a second in (skips black lead-in frames), or 10% of a very short clip.
    await at(duration > 10 ? 1 : duration * 0.1);
    const [thumb, preview] = await Promise.all([
      encode(video, width, height, THUMB_EDGE, 0.8),
      encode(video, width, height, PREVIEW_EDGE, 0.85),
    ]);
    const phash = dhash(video);
    const frames: Blob[] = [];
    if (duration > 2)
      for (const fraction of [0.1, 0.5, 0.9]) {
        await at(duration * fraction);
        const frame = await encode(video, width, height, FRAME_EDGE, 0.8);
        if (frame) frames.push(frame);
      }
    return { width, height, duration_ms: Math.round(duration * 1000), thumb, preview, frames, phash };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}

export async function derive(file: File, kind: 'image' | 'video'): Promise<Derived> {
  try {
    const derived = kind === 'video' ? await deriveVideo(file) : await deriveImage(file);
    // Both or neither: a thumbnail without a preview (or the reverse) counts as no preview.
    return derived.thumb && derived.preview ? derived : { ...derived, thumb: null, preview: null, frames: [] };
  } catch {
    return NONE;
  }
}
