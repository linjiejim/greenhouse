/**
 * The asset library runs as a trusted embed. The host hands it the member, locale, theme and a
 * ten-minute token scoped to /api/ext/assets (plus the member directory); a link such as
 * `#/ext/assets/asset/<id>` arrives as the init `route`. Wiring, confirms and notices come from
 * the shared kit (`@greenhouse/ui-tokens/react`).
 */
import { createEmbed, useEmbed as useKitEmbed, type EmbedState } from '@greenhouse/ui-tokens/react';

export type Locale = 'en' | 'zh';

/** Host links (`#/ext/assets/asset/<id>`) become this frame's own hash routes (`#/asset/<id>`). */
export function routeFromHost(route: string | undefined): string {
  const match = /^#\/ext\/assets\/asset\/([^/?#]+)/.exec(route ?? '');
  if (match) return `#/asset/${match[1]}`;
  return route?.startsWith('#/') && !route.startsWith('#/ext/') ? route : '#/';
}

const embed = createEmbed({
  title: (locale) => (locale === 'en' ? 'Asset library' : '素材库'),
  onInit(init) {
    const hash = routeFromHost(init.route);
    if (window.location.hash !== hash) window.location.hash = hash;
  },
});

export const bridge = embed.bridge;
export const embedFetch = embed.embedFetch;
export const retryConnection = embed.retry;

/** The connection state, read through a selector. */
export function useEmbed<T>(select: (state: EmbedState & { ready: boolean }) => T): T {
  const state = useKitEmbed();
  return select({ ...state, ready: state.status === 'ready' });
}
