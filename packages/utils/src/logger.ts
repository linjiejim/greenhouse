/**
 * Lightweight structured logger.
 * Provides consistent formatting for info, warn, and error messages.
 */

type LogData = Record<string, unknown> | undefined;

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3, silent: 4 } as const;

/**
 * Reads the active threshold from `LOG_LEVEL` on every call so tests (or a
 * developer debugging one) can flip it via env without re-importing. Defaults
 * to `info`, preserving the previous always-log behavior in production.
 */
function threshold(): number {
  // Guard `process` — this package is also bundled into the browser, where the
  // global doesn't exist (`process is not defined`).
  const lvl = (typeof process !== 'undefined' ? process.env?.LOG_LEVEL : undefined)?.toLowerCase();
  return lvl && lvl in LEVELS ? LEVELS[lvl as keyof typeof LEVELS] : LEVELS.info;
}

export const logger = {
  info: (msg: string, data?: LogData) => {
    if (threshold() <= LEVELS.info) console.log(`[INFO] ${msg}`, data ?? '');
  },
  warn: (msg: string, data?: LogData) => {
    if (threshold() <= LEVELS.warn) console.warn(`[WARN] ${msg}`, data ?? '');
  },
  error: (msg: string, err?: unknown) => {
    if (threshold() <= LEVELS.error) console.error(`[ERROR] ${msg}`, err ?? '');
  },
};
