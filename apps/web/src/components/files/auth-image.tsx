/**
 * Images behind the authenticated chat-file route
 * (`/api/chat-files/:id/content`) — a Bot's browser screenshot, a picture it
 * shared, an image the member attached. `<img src>` cannot carry the Bearer
 * token, so the bytes are fetched with authFetch (the same path attachment
 * chips use) and shown through a blob: URL that is revoked when the image
 * goes away.
 *
 * Only raster image types are ever shown (`isSafeAttachmentPreview`): a
 * chat file that is not an image — or an SVG — never becomes a blob: document.
 * Every other image (public `/api/upload/` ids, external URLs) keeps its plain
 * `<img>`.
 *
 * Two consumers: `<AuthImage>` for React-rendered cards, and
 * `hydrateAuthImages` for the Markdown renderer, whose body is one sanitized
 * HTML island (it marks these images with `data-auth-src` instead of `src`).
 */

import { useEffect, useState } from 'react';
import { Image as ImageIcon } from '../../lib/icons';
import { fetchAuthenticatedBlob } from '../../lib/file-download';
import { isSafeAttachmentPreview } from '../blocks/attachments-block';

/** The one authenticated image route — exact shape, so nothing else rides the member's token. */
const AUTH_IMAGE_SRC = /^\/api\/chat-files\/[A-Za-z0-9_-]+\/content$/;

export function isAuthImageSrc(src: string | null | undefined): src is string {
  return typeof src === 'string' && AUTH_IMAGE_SRC.test(src.trim());
}

// One fetch per image per tab: a transcript re-renders its Markdown on every
// streamed token, and the live → persisted swap remounts every card. Bounded,
// oldest out first.
const CACHE_LIMIT = 40;
const blobs = new Map<string, Promise<Blob>>();
/** The loads that already landed, readable synchronously: a re-rendered island shows them before paint. */
const loaded = new Map<string, Blob>();

function loadAuthImage(src: string): Promise<Blob> {
  const cached = blobs.get(src);
  if (cached) return cached;
  const request = fetchAuthenticatedBlob(src).then((blob) => {
    if (!isSafeAttachmentPreview('image', blob.type)) throw new Error('Not a previewable image');
    if (blobs.get(src) === request) loaded.set(src, blob);
    return blob;
  });
  // A failure is not remembered: the next render may try again (a token refresh, a flaky network).
  request.catch(() => {
    if (blobs.get(src) === request) blobs.delete(src);
  });
  blobs.set(src, request);
  if (blobs.size > CACHE_LIMIT) {
    const oldest = blobs.keys().next().value;
    if (oldest !== undefined) {
      blobs.delete(oldest);
      loaded.delete(oldest);
    }
  }
  return request;
}

/** Test hook: forget every cached image. */
export function resetAuthImageCacheForTest(): void {
  blobs.clear();
  loaded.clear();
}

/** A blob: URL for an authenticated image, revoked on unmount or when `src` changes. */
export function useAuthImage(src: string): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ src: string; url: string | null; failed: boolean } | null>(null);
  const valid = isAuthImageSrc(src);

  useEffect(() => {
    if (!valid) return;
    let objectUrl: string | null = null;
    let alive = true;
    loadAuthImage(src.trim()).then(
      (blob) => {
        if (!alive) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ src, url: objectUrl, failed: false });
      },
      () => {
        if (alive) setState({ src, url: null, failed: true });
      },
    );
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, valid]);

  if (!valid) return { url: null, failed: true };
  // A state left over from the previous `src` (its URL already revoked) is not this image.
  return state?.src === src ? { url: state.url, failed: state.failed } : { url: null, failed: false };
}

export function AuthImage({
  src,
  alt,
  className = '',
  onOpen,
}: {
  src: string;
  alt: string;
  className?: string;
  /** Clicked once loaded — gets the blob: URL (e.g. to open the lightbox). */
  onOpen?: (url: string) => void;
}) {
  const { url, failed } = useAuthImage(src);
  if (!url) {
    return (
      <span
        className={`flex h-32 w-48 max-w-full items-center justify-center rounded-lg border border-edge bg-surface-sunken text-fg-faint ${
          failed ? '' : 'animate-pulse'
        }`}
        role="img"
        aria-label={alt}
        aria-busy={!failed}
        data-testid="auth-image-placeholder"
        data-failed={failed || undefined}
      >
        <ImageIcon size={18} aria-hidden="true" />
      </span>
    );
  }
  const image = <img src={url} alt={alt} className={className} data-testid="auth-image" />;
  if (!onOpen) return image;
  return (
    <button
      type="button"
      onClick={() => onOpen(url)}
      className="block max-w-full cursor-zoom-in overflow-hidden rounded-lg"
      title={alt}
    >
      {image}
    </button>
  );
}

/**
 * Fill every `img[data-auth-src]` under `root` (the Markdown island) with its
 * blob: URL — synchronously for images already loaded, so a streaming reply
 * that re-renders its HTML on every token does not blink. Returns the
 * cleanup: stop pending loads from landing and revoke what was created.
 * Images that cannot be loaded keep their alt text.
 */
export function hydrateAuthImages(root: HTMLElement): () => void {
  let alive = true;
  const created: string[] = [];
  for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[data-auth-src]'))) {
    const src = img.getAttribute('data-auth-src')?.trim();
    if (!isAuthImageSrc(src)) continue;
    const ready = loaded.get(src);
    if (ready) {
      const url = URL.createObjectURL(ready);
      created.push(url);
      img.src = url;
      continue;
    }
    img.setAttribute('aria-busy', 'true');
    loadAuthImage(src).then(
      (blob) => {
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        created.push(url);
        img.src = url;
        img.removeAttribute('aria-busy');
      },
      () => {
        if (!alive) return;
        img.removeAttribute('aria-busy');
        img.setAttribute('data-auth-failed', 'true');
      },
    );
  }
  return () => {
    alive = false;
    created.forEach((url) => URL.revokeObjectURL(url));
  };
}
