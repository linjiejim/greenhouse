/** Browser-local invalidation for the cached personal workbench projection. */

export const WORKBENCH_CHANGED_EVENT = 'greenhouse:workbench-changed';

/** Announce that a server-side workbench mutation has finished. */
export function notifyWorkbenchChanged(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event(WORKBENCH_CHANGED_EVENT));
}

/** Subscribe without coupling the global chat stream manager to the platform store. */
export function onWorkbenchChanged(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(WORKBENCH_CHANGED_EVENT, listener);
  return () => window.removeEventListener(WORKBENCH_CHANGED_EVENT, listener);
}
