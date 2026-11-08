/**
 * An open embed's own Back (`greenhouse:back`), shared between the EmbedScreen that hears it and the
 * wide web header that draws it (page-screen.web.tsx). One entry per plugin page, so pages kept in
 * the stack keep theirs while another one comes and goes.
 */
import { useSyncExternalStore } from 'react';

const backs = new Map<string, () => void>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export function setEmbedBack(key: string, request: (() => void) | null) {
  if (request) backs.set(key, request);
  else if (!backs.delete(key)) return;
  for (const listener of listeners) listener();
}

/** The page's Back while it shows a sub-view, else null. */
export function useEmbedBack(key: string): (() => void) | null {
  return useSyncExternalStore(subscribe, () => backs.get(key) ?? null);
}

/** Only a back gesture goes into the page; leaving for another place always closes it. */
export function isBackAction(type: string): boolean {
  return type === 'GO_BACK' || type === 'POP';
}
