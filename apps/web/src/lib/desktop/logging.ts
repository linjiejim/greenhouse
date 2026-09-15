/**
 * Forward web-layer errors into the shell's log file.
 *
 * A packaged build has no devtools and its log previously contained nothing from the
 * webview at all — a user reporting "it just hangs" left us with a log full of
 * window-resize events. Anything that would have gone to a console nobody can see now
 * lands in the shell's log file (`~/Library/Logs/<bundle identifier>/Greenhouse.log` on macOS).
 *
 * Only warnings and errors are forwarded, plus uncaught errors and unhandled promise
 * rejections — the two failure modes that produce a silently stuck UI.
 */

import { invokeDesktop, isDesktop } from './bridge';

type Level = 'debug' | 'info' | 'warn' | 'error';

/**
 * Guard against a logging loop, i.e. `invokeDesktop` itself logging an error.
 *
 * Held only for the synchronous duration of the call — NOT across the promise. An
 * await-spanning flag would drop every error that arrived in the same tick as
 * another, and errors habitually arrive in bursts (an uncaught error plus its
 * unhandled rejection, React logging twice). Losing the second one is how a log
 * ends up describing the wrong problem.
 */
let forwarding = false;

function forward(level: Level, message: string): void {
  if (forwarding) return;
  forwarding = true;
  try {
    void invokeDesktop('desktop_log', { level, message }).catch(() => {
      /* If the shell can't log, there is nowhere left to report it. */
    });
  } finally {
    forwarding = false;
  }
}

/** Render console arguments to one line, without throwing on cycles. */
function format(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === 'string') return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(' ');
}

/** Start forwarding. Returns a teardown that restores the original console methods. */
export function initDesktopLogging(): () => void {
  if (!isDesktop()) return () => {};

  const original = { warn: console.warn, error: console.error };

  console.warn = (...args: unknown[]) => {
    original.warn(...args);
    forward('warn', format(args));
  };
  console.error = (...args: unknown[]) => {
    original.error(...args);
    forward('error', format(args));
  };

  const onError = (event: ErrorEvent) => {
    forward('error', `uncaught: ${event.message} (${event.filename}:${event.lineno})`);
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason = event.reason;
    forward('error', `unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
  };

  window.addEventListener('error', onError);
  window.addEventListener('unhandledrejection', onRejection);

  return () => {
    console.warn = original.warn;
    console.error = original.error;
    window.removeEventListener('error', onError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
