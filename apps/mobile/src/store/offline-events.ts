/** "An offline copy changed" — for readers that mirror copies elsewhere (the widgets). */

const listeners = new Set<(kind: string) => void>();

export function notifyOfflineChanged(kind: string): void {
  for (const listener of listeners) listener(kind);
}

export function onOfflineChanged(listener: (kind: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
