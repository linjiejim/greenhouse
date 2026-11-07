/**
 * An open embed's own Back (`greenhouse:back`), shared between the EmbedScreen that hears it and the
 * wide web header that draws it (page-screen.web.tsx). Keyed by plugin page so a page that closes
 * never clears the Back of the one that replaced it.
 */
import { useSyncExternalStore } from 'react';

let current: { key: string; request: () => void } | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function setEmbedBack(key: string, request: (() => void) | null) {
  if (request) current = { key, request };
  else if (current?.key === key) current = null;
  else return;
  for (const listener of listeners) listener();
}

/** The page's Back while it shows a sub-view, else null. */
export function useEmbedBack(key: string): (() => void) | null {
  return useSyncExternalStore(subscribe, () => (current?.key === key ? current.request : null));
}

/** Only a back gesture goes into the page; leaving for another place always closes it. */
export function isBackAction(type: string): boolean {
  return type === 'GO_BACK' || type === 'POP';
}
