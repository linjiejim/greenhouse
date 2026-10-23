/**
 * What a part of a screen shows for its own load. React-free (./load-view.test.ts): its data once
 * it has some, a failure with a retry once a load failed and none is running, else loading. Each
 * part of a screen that loads on its own shows its own failure instead of disappearing.
 */

export type LoadView = 'ready' | 'failed' | 'loading';

export function loadView(part: { data: unknown; loading: boolean; error: unknown }): LoadView {
  if (part.data !== null && part.data !== undefined) return 'ready';
  return part.error && !part.loading ? 'failed' : 'loading';
}
