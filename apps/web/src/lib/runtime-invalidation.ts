const RUNTIME_INVALIDATED_EVENT = 'greenhouse:runtime-invalidated';

/** Notify all Runtime read-model consumers after a user command succeeds. */
export function notifyRuntimeInvalidated(runId?: string): void {
  window.dispatchEvent(new CustomEvent<string | undefined>(RUNTIME_INVALIDATED_EVENT, { detail: runId }));
}

export function onRuntimeInvalidated(listener: (runId?: string) => void): () => void {
  const handler = (event: Event) => listener((event as CustomEvent<string | undefined>).detail);
  window.addEventListener(RUNTIME_INVALIDATED_EVENT, handler);
  return () => window.removeEventListener(RUNTIME_INVALIDATED_EVENT, handler);
}
