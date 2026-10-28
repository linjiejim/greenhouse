/**
 * Catching errors in a browser (and the macOS shell): the window's error event (it also receives
 * React's uncaught render errors) and unhandled promise rejections. A page does not die of them,
 * so they are not fatal; closing a tab is a normal end, so there is no session mark.
 */

import type { Reporter } from './reporter';

/** Browser noise that says nothing about the app. */
const IGNORED = [/^ResizeObserver loop/, /^Script error\.?$/];

export function installCapture(reporter: Reporter): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    const error: unknown = event.error ?? event.message;
    const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
    if (IGNORED.some((pattern) => pattern.test(text))) return;
    reporter.record(error, { fatal: false, source: 'window' });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reporter.record(event.reason, { fatal: false, source: 'promise' });
  });
}
