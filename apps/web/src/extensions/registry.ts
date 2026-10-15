import type { WebExtension } from './define';

export let WEB_EXTENSIONS: readonly WebExtension[] = [];

/** Called once by the Web composition root, before React mounts. */
export function registerWebExtensions(extensions: readonly WebExtension[]) {
  if (new Set(extensions.map((extension) => extension.id)).size !== extensions.length)
    throw new Error('Duplicate web extension id');
  WEB_EXTENSIONS = extensions;
}
