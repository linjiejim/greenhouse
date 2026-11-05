/**
 * The asset library runs as a trusted embed. The host hands it the member, locale, theme and a
 * ten-minute token scoped to /api/ext/assets (plus the member directory); a link such as
 * `#/ext/assets/asset/<id>` arrives as the init `route`.
 */
import { connectGreenhouse } from '@greenhouse/ui-tokens';
import { create } from 'zustand';

export type Locale = 'en' | 'zh';

interface EmbedState {
  ready: boolean;
  locale: Locale;
  user: { id: string; name: string; role: 'super' | 'team' } | null;
}

export const useEmbed = create<EmbedState>(() => ({ ready: false, locale: 'zh', user: null }));

/** Host links (`#/ext/assets/asset/<id>`) become this frame's own hash routes (`#/asset/<id>`). */
export function routeFromHost(route: string | undefined): string {
  const match = /^#\/ext\/assets\/asset\/([^/?#]+)/.exec(route ?? '');
  if (match) return `#/asset/${match[1]}`;
  return route?.startsWith('#/') && !route.startsWith('#/ext/') ? route : '#/';
}

// Desktop is an installed, trusted host that names itself; nothing else may.
const hinted = new URLSearchParams(window.location.search).get('host_origin');

export const bridge = connectGreenhouse({
  hostOrigin: hinted === 'tauri://localhost' ? hinted : window.location.origin,
  onInit(init) {
    useEmbed.setState({ ready: true, locale: init.locale === 'en' ? 'en' : 'zh', user: init.user });
    const hash = routeFromHost(init.route);
    if (window.location.hash !== hash) window.location.hash = hash;
  },
});

/** fetch() with the embed token; one transparent renewal through the host on 401. */
export async function embedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const send = (token: string) => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(input, { ...init, headers });
  };
  const response = await send(bridge.token);
  if (response.status !== 401) return response;
  return send(await bridge.refresh());
}
